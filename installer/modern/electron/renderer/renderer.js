const primaryButton = document.getElementById('primaryButton')
const primaryButtonLabel = document.getElementById('primaryButtonLabel')
const secondaryButton = document.getElementById('secondaryButton')
const statusKicker = document.getElementById('statusKicker')
const statusTitle = document.getElementById('statusTitle')
const statusMessage = document.getElementById('statusMessage')
const progressValue = document.getElementById('progressValue')
const progressBar = document.getElementById('progressBar')
const actionHint = document.getElementById('actionHint')
const toast = document.getElementById('toast')
const steps = [...document.querySelectorAll('.step')]
const stepLines = [...document.querySelectorAll('.step-line')]

let currentState = 'ready'
let toastTimer

const presentation = {
  ready: {
    kicker: 'READY TO INSTALL',
    title: 'Everything is prepared',
    message: 'Program files are refreshed; the venue’s own data is never touched.',
    button: 'Install now',
    hint: 'Usually takes 1–3 minutes'
  },
  starting: {
    kicker: 'STARTING',
    title: 'Opening secure engine',
    message: 'Preparing a protected installation session…',
    button: 'Please wait',
    hint: 'Keep this window open'
  },
  preparing: {
    kicker: 'PREPARING',
    title: 'Closing the running desk',
    message: 'Stopping any running NPL Poker OS before files are replaced…',
    button: 'Installing',
    hint: 'Keep this window open'
  },
  installing: {
    kicker: 'INSTALLING',
    title: 'Updating NPL Poker OS',
    message: 'Copying verified application files…',
    button: 'Installing',
    hint: 'Keep this window open'
  },
  configuring: {
    kicker: 'VERIFYING',
    title: 'Checking every installed file',
    message: 'Confirming the runtime landed complete on disk…',
    button: 'Finishing',
    hint: 'Administrator approval may appear'
  },
  completed: {
    kicker: 'INSTALLATION COMPLETE',
    title: 'NPL Poker OS is ready',
    message: 'Version 1.3.0 is installed — the venue desk can open right away.',
    button: 'Launch NPL Poker OS',
    hint: 'Installation completed successfully'
  },
  failed: {
    kicker: 'ACTION REQUIRED',
    title: 'Installation needs attention',
    message: 'The install did not complete. Open the logs for the exact reason.',
    button: 'Try again',
    hint: 'The venue’s existing install and data are untouched'
  }
}

function showToast(message) {
  clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add('visible')
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200)
}

function normalizeState(state) {
  if (['starting', 'preparing', 'installing', 'configuring', 'completed', 'failed'].includes(state)) {
    return state
  }

  if (state === 'warning') {
    return 'configuring'
  }

  if (state === 'cancelled') {
    return 'failed'
  }

  return currentState
}

function updateSteps(state) {
  const level = state === 'completed' ? 3 : state === 'ready' ? 1 : 2
  steps.forEach((step, index) => step.classList.toggle('active', index < level))
  stepLines.forEach((line, index) => line.classList.toggle('complete', index < level - 1))
}

function updateStatus(payload) {
  if (payload.state === 'close-blocked') {
    showToast(payload.message)
    return
  }

  currentState = normalizeState(payload.state)
  const view = presentation[currentState]
  const progress = Math.max(0, Math.min(100, Number(payload.progress ?? 0)))

  document.body.dataset.state = currentState
  statusKicker.textContent = view.kicker
  statusTitle.textContent = view.title
  statusMessage.textContent = payload.message || view.message
  progressValue.textContent = `${Math.round(progress)}%`
  progressBar.style.width = `${progress}%`
  primaryButtonLabel.textContent = view.button
  actionHint.textContent = view.hint
  primaryButton.disabled = !['ready', 'completed', 'failed'].includes(currentState)
  secondaryButton.classList.toggle('hidden', currentState !== 'failed')
  updateSteps(currentState)
}

primaryButton.addEventListener('click', async () => {
  if (currentState === 'completed') {
    const problem = await window.installer.launchApp()
    if (problem) {
      showToast(problem)
      return
    }
    window.installer.close()
    return
  }

  if (currentState === 'ready' || currentState === 'failed') {
    updateStatus({ state: 'starting', progress: 5 })
    const result = await window.installer.start()
    if (!result.ok && result.reason === 'already-running') {
      showToast('The installer is already running.')
    }
  }
})

secondaryButton.addEventListener('click', async () => {
  const result = await window.installer.openLogs()
  if (result) {
    showToast(result)
  }
})

document.getElementById('minimizeButton').addEventListener('click', () => window.installer.minimize())
document.getElementById('closeButton').addEventListener('click', () => window.installer.close())
window.installer.onStatus(updateStatus)
updateStatus({ state: 'ready', progress: 0 })
