const ipcRenderer = window.ipcRenderer
const store = window.store

let isLoading = false
let connectAddress
let listenPort
let platform
let version
let onlineMode
const listenPortInput = document.getElementById('listen-port')
const listenPortPreview = document.getElementById('listen-port-preview')

function updateListenPortPreview () {
  const fallbackPort = document.getElementById('platform').value === 'bedrock' ? '19142' : '25566'
  listenPortPreview.textContent = listenPortInput.value || fallbackPort
}

listenPortInput.addEventListener('input', updateListenPortPreview)

loadSetting('lastPlatform', 'platform', 'platform', 'java')
let lastPlatform = platform
platformChange()
loadSettings(platform)

function loadSettings (newPlatform) {
  loadSetting(newPlatform + 'LastVersion', 'version', 'version', newPlatform === 'java' ? 'auto' : '1.21.11')
  loadSetting(newPlatform + 'LastConnectAddress', 'connectAddress', 'connect-address', 'localhost')
  loadSetting(newPlatform + 'LastListenPort', 'listenPort', 'listen-port', platform === 'java' ? '25566' : '19142')
  loadSetting(newPlatform + 'LastOnlineMode', 'onlineMode', 'auth-online', true)
}

function saveSettings (thePlatform) {
  store.set('lastPlatform', platform)
  store.set(thePlatform + 'LastVersion', version)
  store.set(thePlatform + 'LastConnectAddress', connectAddress)
  store.set(thePlatform + 'LastListenPort', listenPort)
  store.set(thePlatform + 'LastOnlineMode', onlineMode)
}

function loadSetting (name, varname, elementID, defaultValue) {
  if (!store.has(name)) {
    store.set(name, defaultValue)
  }

  window[varname] = store.get(name)
  if (varname == 'onlineMode') {
    document.getElementById(elementID).checked = window[varname]
  } else {
    document.getElementById(elementID).value = window[varname]
  }
}

function updateVars () {
  connectAddress = document.getElementById('connect-address').value
  listenPort = document.getElementById('listen-port').value
  platform = document.getElementById('platform').value
  version = document.getElementById('version').value
  onlineMode = document.getElementById('auth-online').checked
}

function platformChange () {
  platform = document.getElementById('platform').value
  if (lastPlatform !== platform) {
    updateVars()
    saveSettings(lastPlatform)
  }
  if (platform === 'bedrock') {
    document.getElementById('version-bedrock').style.display = 'block'
    document.getElementById('version').style.display = 'none'
    document.getElementById('auth-row').style.display = 'none'
  } else {
    document.getElementById('version').style.display = 'block'
    document.getElementById('version-bedrock').style.display = 'none'
    document.getElementById('auth-row').style.display = 'flex'
  }
  loadSettings(platform)
  lastPlatform = platform
  updateListenPortPreview()
}

function startProxy (event) {
  if (isLoading) {
    return
  }
  isLoading = true
  event.preventDefault()
  document.getElementById('start').disabled = true
  document.getElementById('start-label').textContent = 'Starting proxy…'
  updateVars()
  saveSettings(platform)
  // If blank use default
  connectAddress = (connectAddress === '') ? 'localhost' : connectAddress
  if (platform === 'bedrock') {
    listenPort = (listenPort === '') ? '19142' : listenPort
  } else {
    listenPort = (listenPort === '') ? '25566' : listenPort
  }
  store.set('authConsentGiven', false)
  // The connect address is resolved (SRV lookup, host:port parsing) in the
  // main process, mirroring how the Minecraft client handles it.
  ipcRenderer.send('startProxy', JSON.stringify({
    consent: store.get('authConsentGiven'),
    connectAddress: connectAddress,
    listenPort: listenPort,
    platform: platform,
    version: version,
    onlineMode: onlineMode
  }))
}

window.startProxy = startProxy
window.platformChange = platformChange
