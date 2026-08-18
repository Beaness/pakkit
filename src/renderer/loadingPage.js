const ipcRenderer = window.ipcRenderer
const status = document.getElementById('loading-status')
const indicator = document.getElementById('loading-indicator')
const actions = document.getElementById('loading-actions')

ipcRenderer.on('minecraft-data-status', (event, payload) => {
  const update = JSON.parse(payload)
  status.textContent = update.message
  indicator.classList.remove('failed')
  actions.hidden = true
})

ipcRenderer.on('minecraft-data-update-error', (event, payload) => {
  const error = JSON.parse(payload)
  status.textContent = error.message
  indicator.classList.add('failed')
  actions.hidden = false
})

document.getElementById('retry-update').addEventListener('click', () => {
  actions.hidden = true
  indicator.classList.remove('failed')
  status.textContent = 'Retrying minecraft-data update…'
  ipcRenderer.send('retryMinecraftDataUpdate')
})

document.getElementById('quit-app').addEventListener('click', () => {
  ipcRenderer.send('quitApp')
})
