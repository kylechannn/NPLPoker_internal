const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('installer', {
  start: () => ipcRenderer.invoke('installer:start'),
  openLogs: () => ipcRenderer.invoke('installer:open-logs'),
  launchApp: () => ipcRenderer.invoke('installer:launch-app'),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('installer:status', listener)
    return () => ipcRenderer.removeListener('installer:status', listener)
  }
})
