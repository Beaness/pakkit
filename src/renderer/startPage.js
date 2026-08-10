const ipcRenderer = window.ipcRenderer
const store = window.store

let isLoading = false
let connectAddress
let listenPort
let version
let onlineMode

const javaVersionSelect = document.getElementById('version')
const listenPortInput = document.getElementById('listen-port')
const listenPortPreview = document.getElementById('listen-port-preview')

function getSetting (name, defaultValue) {
  if (!store.has(name)) store.set(name, defaultValue)
  return store.get(name)
}

function updateListenPortPreview () {
  listenPortPreview.textContent = listenPortInput.value || '25566'
}

function readForm () {
  connectAddress = document.getElementById('connect-address').value
  listenPort = listenPortInput.value
  version = javaVersionSelect.value
  onlineMode = document.getElementById('auth-online').checked
}

function loadSettings () {
  const fallbackVersion = 'auto'
  const storedVersion = getSetting('javaLastVersion', fallbackVersion)
  const select = javaVersionSelect
  const supported = Array.from(select.options).some(option => option.value === storedVersion)
  version = supported ? storedVersion : fallbackVersion
  if (!supported) store.set('javaLastVersion', version)
  select.value = version

  connectAddress = getSetting('javaLastConnectAddress', 'localhost')
  listenPort = getSetting('javaLastListenPort', '25566')
  onlineMode = getSetting('javaLastOnlineMode', true)

  document.getElementById('connect-address').value = connectAddress
  listenPortInput.value = listenPort
  document.getElementById('auth-online').checked = onlineMode
}

function saveSettings () {
  store.set('javaLastVersion', version)
  store.set('javaLastConnectAddress', connectAddress)
  store.set('javaLastListenPort', listenPort)
  store.set('javaLastOnlineMode', onlineMode)
}

loadSettings()

function startProxy (event) {
  event.preventDefault()
  if (isLoading) return

  isLoading = true
  document.getElementById('start').disabled = true
  document.getElementById('start-label').textContent = 'Starting proxy…'
  readForm()
  saveSettings()

  connectAddress = connectAddress || 'localhost'
  listenPort = listenPort || '25566'
  store.set('authConsentGiven', false)

  ipcRenderer.send('startProxy', JSON.stringify({
    consent: store.get('authConsentGiven'),
    connectAddress,
    listenPort,
    version,
    onlineMode
  }))
}

listenPortInput.addEventListener('input', updateListenPortPreview)
updateListenPortPreview()

window.startProxy = startProxy
