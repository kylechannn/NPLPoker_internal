//go:build !windows

package main

import "os/exec"

func configureBackgroundProcess(_ *exec.Cmd) {}

func adoptBackgroundProcess(_ *exec.Cmd) {}
