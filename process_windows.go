//go:build windows

package main

import (
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

func configureBackgroundProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

var (
	backgroundJob     windows.Handle
	backgroundJobOnce sync.Once
)

// ensureBackgroundJob lazily creates one kill-on-close job object for the
// host's lifetime. The handle is deliberately never closed: Windows closes it
// when this process dies — however it dies — and that close is what tears the
// job down.
func ensureBackgroundJob() windows.Handle {
	backgroundJobOnce.Do(func() {
		job, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			return
		}

		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
			BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
				LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
			},
		}
		if _, err := windows.SetInformationJobObject(
			job,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info)),
		); err != nil {
			_ = windows.CloseHandle(job)

			return
		}

		backgroundJob = job
	})

	return backgroundJob
}

// adoptBackgroundProcess ties a started child (and any processes IT spawns —
// `php artisan serve` runs the real server as a grandchild) to this process's
// lifetime. Without it, killing the host leaves php.exe and caddy.exe running
// and holding their ports, and the next start finds the gateway port taken.
func adoptBackgroundProcess(cmd *exec.Cmd) {
	job := ensureBackgroundJob()
	if job == 0 || cmd == nil || cmd.Process == nil {
		return
	}

	handle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		return
	}
	defer windows.CloseHandle(handle)

	_ = windows.AssignProcessToJobObject(job, handle)
}
