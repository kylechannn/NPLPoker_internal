const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// The NPL Poker OS take on the Mahjong modern installer: Electron owns
// the experience, the embedded Inno Setup engine owns the real install.
// The engine runs /VERYSILENT and reports through a temp status file.

let mainWindow
let installerProcess
let pollTimer
let activeRun

function resolveEnginePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'payload', 'NPLPokerOS-Engine.exe')
  }

  return path.join(__dirname, '..', 'payload', 'NPLPokerOS-Engine.exe')
}

function installedAppPath() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  return path.join(programFiles, 'NPL Poker OS', 'NPLPokerOS.exe')
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('installer:status', status)
  }
}

function readStatusFile(statusFile) {
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8'))
  } catch {
    return null
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function finishRun(code, signal) {
  stopPolling()
  const reported = activeRun ? readStatusFile(activeRun.statusFile) : null
  const completed = code === 0 && reported && reported.state === 'completed'

  if (completed) {
    sendStatus(reported)
  } else if (!reported || !['failed', 'cancelled'].includes(reported.state)) {
    sendStatus({
      state: 'failed',
      progress: reported?.progress ?? 100,
      message: signal
        ? `Installation stopped unexpectedly (${signal}).`
        : `Installation could not finish (exit code ${code ?? 'unknown'}).`,
      logFile: activeRun?.logFile ?? ''
    })
  } else {
    sendStatus({ ...reported, logFile: activeRun?.logFile ?? '' })
  }

  installerProcess = undefined
}

function startPolling(statusFile, logFile) {
  let lastPayload = ''

  pollTimer = setInterval(() => {
    const status = readStatusFile(statusFile)
    if (!status) {
      return
    }

    const payload = JSON.stringify(status)
    if (payload === lastPayload) {
      return
    }

    lastPayload = payload
    sendStatus({ ...status, logFile })
  }, 250)
}

function startInstaller() {
  if (installerProcess) {
    return { ok: false, reason: 'already-running' }
  }

  if (process.env.INSTALLER_PREVIEW === '1') {
    const sequence = [
      { state: 'starting', progress: 5, message: 'Opening the NPL Poker OS installation engine…' },
      { state: 'preparing', progress: 8, message: 'Closing any running NPL Poker OS…' },
      { state: 'installing', progress: 34, message: 'Copying verified NPL Poker OS files…' },
      { state: 'installing', progress: 67, message: 'Copying verified NPL Poker OS files…' },
      { state: 'configuring', progress: 90, message: 'Verifying every installed file…' },
      { state: 'completed', progress: 100, message: 'NPL Poker OS is installed and ready.' }
    ]
    installerProcess = { preview: true }
    sequence.forEach((status, index) => {
      setTimeout(() => {
        sendStatus(status)
        if (index === sequence.length - 1) {
          installerProcess = undefined
        }
      }, index * 780)
    })
    return { ok: true }
  }

  const enginePath = resolveEnginePath()
  if (!fs.existsSync(enginePath)) {
    sendStatus({
      state: 'failed',
      progress: 0,
      message: 'The packaged Inno Setup engine is missing. Rebuild the installer package.'
    })
    return { ok: false, reason: 'engine-missing' }
  }

  const runId = `${process.pid}-${Date.now()}`
  const statusFile = path.join(os.tmpdir(), `nplpoker-os-status-${runId}.json`)
  const logFile = path.join(os.tmpdir(), `nplpoker-os-install-${runId}.log`)
  const args = [
    '/VERYSILENT',
    '/SP-',
    '/NORESTART',
    '/NOCANCEL',
    '/CLOSEAPPLICATIONS',
    `/STATUSFILE=${statusFile}`,
    `/LOG=${logFile}`
  ]

  activeRun = { statusFile, logFile }
  sendStatus({ state: 'starting', progress: 5, message: 'Opening the NPL Poker OS installation engine…' })
  startPolling(statusFile, logFile)

  try {
    installerProcess = spawn(enginePath, args, {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch (error) {
    stopPolling()
    installerProcess = undefined
    sendStatus({ state: 'failed', progress: 0, message: error.message, logFile })
    return { ok: false, reason: 'spawn-failed' }
  }

  installerProcess.once('error', (error) => {
    stopPolling()
    installerProcess = undefined
    sendStatus({ state: 'failed', progress: 0, message: error.message, logFile })
  })

  installerProcess.once('exit', finishRun)
  return { ok: true }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 860,
    minHeight: 600,
    show: false,
    frame: false,
    thickFrame: true,
    backgroundColor: '#050b1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.on('close', (event) => {
    if (installerProcess) {
      event.preventDefault()
      sendStatus({
        state: 'close-blocked',
        message: 'Installation is in progress. Keep this window open until it finishes.'
      })
    }
  })
}

ipcMain.handle('installer:start', startInstaller)
ipcMain.handle('installer:open-logs', async () => {
  const installedLogs = path.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'NPL Poker OS',
    'logs'
  )
  if (fs.existsSync(installedLogs)) {
    return shell.openPath(installedLogs)
  }

  if (activeRun?.logFile && fs.existsSync(activeRun.logFile)) {
    return shell.showItemInFolder(activeRun.logFile)
  }

  return 'No installer log is available yet.'
})
ipcMain.handle('installer:launch-app', async () => {
  const exe = installedAppPath()
  if (!fs.existsSync(exe)) {
    return 'NPL Poker OS was not found at its install location.'
  }

  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
    child.unref()
    return ''
  } catch (error) {
    return `NPL Poker OS could not be launched: ${error.message}`
  }
})
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:close', () => mainWindow?.close())

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !installerProcess) {
    app.quit()
  }
})
