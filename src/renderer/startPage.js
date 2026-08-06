const ipcRenderer = window.ipcRenderer
const store = window.store

let isLoading = false
let connectAddress
let listenPort
let platform
let version
let onlineMode

const platformSelect = document.getElementById('platform')
const javaVersionSelect = document.getElementById('version')
const bedrockVersionSelect = document.getElementById('version-bedrock')
const listenPortInput = document.getElementById('listen-port')
const listenPortPreview = document.getElementById('listen-port-preview')

function getSetting (name, defaultValue) {
  if (!store.has(name)) store.set(name, defaultValue)
  return store.get(name)
}

function versionSelect (edition) {
  return edition === 'bedrock' ? bedrockVersionSelect : javaVersionSelect
}

function defaultVersion (edition) {
  return edition === 'bedrock' ? '1.26.40' : 'auto'
}

function updateListenPortPreview () {
  const fallbackPort = platformSelect.value === 'bedrock' ? '19142' : '25566'
  listenPortPreview.textContent = listenPortInput.value || fallbackPort
}

function readForm (edition) {
  connectAddress = document.getElementById('connect-address').value
  listenPort = listenPortInput.value
  platform = edition
  version = versionSelect(edition).value
  onlineMode = document.getElementById('auth-online').checked
}

function loadSettings (edition) {
  const fallbackVersion = defaultVersion(edition)
  const storedVersion = getSetting(edition + 'LastVersion', fallbackVersion)
  const select = versionSelect(edition)
  const supported = Array.from(select.options).some(option => option.value === storedVersion)
  version = supported ? storedVersion : fallbackVersion
  if (!supported) store.set(edition + 'LastVersion', version)
  select.value = version

  connectAddress = getSetting(edition + 'LastConnectAddress', 'localhost')
  listenPort = getSetting(edition + 'LastListenPort', edition === 'java' ? '25566' : '19142')
  onlineMode = getSetting(edition + 'LastOnlineMode', true)

  document.getElementById('connect-address').value = connectAddress
  listenPortInput.value = listenPort
  document.getElementById('auth-online').checked = onlineMode
}

function saveSettings (edition) {
  store.set('lastPlatform', edition)
  store.set(edition + 'LastVersion', version)
  store.set(edition + 'LastConnectAddress', connectAddress)
  store.set(edition + 'LastListenPort', listenPort)
  store.set(edition + 'LastOnlineMode', onlineMode)
}

let lastPlatform = getSetting('lastPlatform', 'java')
platformSelect.value = lastPlatform
platform = lastPlatform
loadSettings(platform)

function platformChange () {
  const nextPlatform = platformSelect.value
  if (lastPlatform !== nextPlatform) {
    readForm(lastPlatform)
    saveSettings(lastPlatform)
  }

  platform = nextPlatform
  if (platform === 'bedrock') {
    bedrockVersionSelect.style.display = 'block'
    javaVersionSelect.style.display = 'none'
    document.getElementById('auth-row').style.display = 'none'
  } else {
    javaVersionSelect.style.display = 'block'
    bedrockVersionSelect.style.display = 'none'
    document.getElementById('auth-row').style.display = 'flex'
  }

  if (lastPlatform !== platform) loadSettings(platform)
  lastPlatform = platform
  updateListenPortPreview()
}

function startProxy (event) {
  event.preventDefault()
  if (isLoading) return

  isLoading = true
  document.getElementById('start').disabled = true
  document.getElementById('start-label').textContent = 'Starting proxy…'
  readForm(platformSelect.value)
  saveSettings(platform)

  connectAddress = connectAddress || 'localhost'
  listenPort = listenPort || (platform === 'bedrock' ? '19142' : '25566')
  store.set('authConsentGiven', false)

  ipcRenderer.send('startProxy', JSON.stringify({
    consent: store.get('authConsentGiven'),
    connectAddress,
    listenPort,
    platform,
    version,
    onlineMode
  }))
}

listenPortInput.addEventListener('input', updateListenPortPreview)
platformChange()

window.startProxy = startProxy
window.platformChange = platformChange
