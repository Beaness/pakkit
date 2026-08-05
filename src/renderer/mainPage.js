/* global Split, jsonTree, escapeHtml, alert, CodeMirror */

import Clusterize from 'clusterize.js'
import * as filteringLogic from './filteringLogic.js'
import './errorHandler.js'
import defaultsJson from './defaults.json'
import * as scripting from './scripting.js'
import * as packetDom from './packetDom.js'
import * as ipcHandler from './ipcHandler.js'
import * as settings from './settings.js'

let currentPacket
let currentPacketType

const filterInput = document.getElementById('filter')

const hiddenPacketsCounter = document.getElementById('hiddenPackets')

// Should improve performance by excluding hidden packets
function wrappedClusterizeUpdate (htmlArray) {
  sharedVars.hiddenPacketsAmount = 0
  const newArray = []
  for (const item of htmlArray) {
    // If the packet is hidden
    if (item[0].match(/<li .* class=".*filter-hidden.*">/)) {
      sharedVars.hiddenPacketsAmount += 1
    } else {
      newArray.push(item)
    }
  }
  clusterize.update(newArray)
  hiddenPacketsCounter.innerHTML = sharedVars.hiddenPacketsAmount + ' hidden packets';
  if (sharedVars.hiddenPacketsAmount != 0) {
    hiddenPacketsCounter.innerHTML += ' (<a href="#" onclick="showAllPackets()">show all</a>)'
  }
}

// Cleaned up from https://css-tricks.com/indeterminate-checkboxes/
function toggleCheckbox (box, packetName, direction) {
  // TODO: collapsing with indeterminate state
  /* if (box.readOnly) {
    box.checked = false
    box.readOnly = false
  } else if (!box.checked) {
    box.readOnly = true
    box.indeterminate = true
  } */
  const check = box.checked

  // console.log('Toggled visibility of', packetName, 'to', box.checked)
  const index = sharedVars.hiddenPackets[direction].indexOf(packetName)
  const currentlyHidden = index !== -1
  console.log(`index ${index} check ${check} currentlyHidden ${currentlyHidden}`);
  if (check && currentlyHidden) {
    // Remove it from the hidden packets
    sharedVars.hiddenPackets[direction].splice(index, 1)
  } else if (!check && !currentlyHidden) {
    // Add it to the hidden packets
    sharedVars.hiddenPackets[direction].push(packetName)
  }

  updateFiltering()
  updateFilteringStorage()
}

function updateFilterBox () {
  const newValue = filterInput.value
  if (sharedVars.lastFilter !== newValue) {
    sharedVars.lastFilter = newValue
    deselectPacket()
    updateFiltering()
  }
}

function updateFiltering () {
  const inverseFiltering = sharedVars.settings.getSetting('inverseFiltering')
  const regexFilter = sharedVars.settings.getSetting('regexFilter')
  let regex
  if (regexFilter) {
    try {
      regex = new RegExp(sharedVars.lastFilter)
    } catch (err) {
      // TODO: handle
      console.error(err)
      regex = new RegExp("")
    }
  }
  sharedVars.allPacketsHTML.forEach(function (item, index, array) {
    if (!filteringLogic.packetFilteredByFilterBox(sharedVars.allPackets[index],
        regexFilter ? regex : sharedVars.lastFilter,
        sharedVars.hiddenPackets,
        inverseFiltering,
        regexFilter,
        sharedVars)) {
      // If it's hidden, show it
      array[index] = [item[0].replace('filter-hidden', 'filter-shown')]
    } else {
      // If it's shown, hide it
      array[index] = [item[0].replace('filter-shown', 'filter-hidden')]
    }
  })
  wrappedClusterizeUpdate(sharedVars.allPacketsHTML)
  clusterize.refresh()
}

setInterval(updateFilterBox, 100)

const sharedVars = {
  allPackets: [],
  allPacketsHTML: [],
  proxyCapabilities: {},
  ipcRenderer: window.ipcRenderer,
  packetList: document.getElementById('packetlist'),
  hiddenPackets: undefined,
  scripting: undefined,
  lastFilter: '',
  hiddenPacketsAmount: 0,
  store: window.store
}

window.sharedVars = sharedVars

sharedVars.proxyCapabilities = JSON.parse(sharedVars.ipcRenderer.sendSync('proxyCapabilities', ''))

function getVersionSpecificVar (name, defaultValue) {
  const versionId = 'version-' + sharedVars.proxyCapabilities.versionId
  const settingsObject = sharedVars.store.get(versionId)
  if (settingsObject) {
    if (!settingsObject[name]) {
      settingsObject[name] = JSON.stringify(defaultValue)
      sharedVars.store.set(versionId, settingsObject)
    }
  } else {
    sharedVars.store.set(versionId, {
      [name]: JSON.stringify(defaultValue)
    })
  }
  return JSON.parse(sharedVars.store.get(versionId)[name])
}

function setVersionSpecificVar (name, value) {
  const versionId = 'version-' + sharedVars.proxyCapabilities.versionId
  const settingsObject = sharedVars.store.get(versionId)
  settingsObject[name] = JSON.stringify(value)
  sharedVars.store.set(versionId, settingsObject)
}

function findDefault (setting) {
  const versionId = sharedVars.proxyCapabilities.versionId
  for (const key in defaultsJson) {
    const regex = new RegExp(key)
    if (versionId.match(regex)) {
      return defaultsJson[key][setting]
    }
  }
}

// TODO: saving and loading custom presets
function findPreset (elem) {
  const name = elem.innerText.match(/Preset: ([\w|\s]+)/i)[1].replace(/\s/g, '_')
  defaultsJson.extended_presets.forEach((value) => {
    if (value.hasOwnProperty(name)) {
      // Copy the object
      // Otherwise it will be a reference and changing it will change the preset
      sharedVars.hiddenPackets = {
        serverbound: [...value[name].serverbound],
        clientbound: [...value[name].clientbound]
      }
    }
  })
}
defaultsJson.extended_presets.forEach((value) => {
  const e = document.createElement('button')
  e.setAttribute('onclick', 'findPreset(this); updateFilteringTab()')
  e.setAttribute('style', 'margin-left: 8px;');
  e.innerText = `Preset: ${Object.keys(value)[0].replace(/_/g, ' ')}`;
  document.getElementById('extendedPresets').appendChild(e)
})

if (!findDefault('useExtendedPresets')) {
  document.getElementById('extendedPresets').style.display = 'none'
}

sharedVars.hiddenPackets = getVersionSpecificVar('hiddenPackets', findDefault('hiddenPackets'))

if (!sharedVars.proxyCapabilities.scriptingSupport) {
  document.getElementById('scriptingTab').style.display = 'none'
}

if (!sharedVars.proxyCapabilities.modifyPackets) {
  document.getElementById('editAndResend').style.display = 'none'
}

Split(['#packets', '#sidebar'], {
  minSize: [50, 75]
})

sharedVars.scripting = scripting
sharedVars.scripting.setup(sharedVars)
sharedVars.packetDom = packetDom
sharedVars.packetDom.setup(sharedVars)
sharedVars.ipcHandler = ipcHandler
sharedVars.ipcHandler.setup(sharedVars)
sharedVars.settings = settings
sharedVars.settings.bindToSettingChange('showTimes', (newValue) => {
  if (newValue) {
    document.body.classList.remove('timeNotShown')
    document.body.classList.add('timeShown')
  } else {
    document.body.classList.remove('timeShown')
    document.body.classList.add('timeNotShown')
  }
})
sharedVars.settings.bindToSettingChange('inverseFiltering', (newValue) => {
  try {
    deselectPacket()
    updateFiltering()
  } catch (e) {}
})
sharedVars.settings.bindToSettingChange('regexFilter', (newValue) => {
  try {
    deselectPacket()
    updateFiltering()
  } catch (e) {}
})
sharedVars.settings.setup(sharedVars)

// TODO: move to own file
const filteringPackets = document.getElementById('filtering-packets')
const filteringPacketSearch = document.getElementById('filtering-packet-search')

function updateFilteringPacketSearch () {
  const search = filteringPacketSearch.value.trim().toLowerCase()

  for (const item of filteringPackets.children) {
    const id = item.querySelector('.id').textContent
    const name = item.querySelector('.name').textContent
    const matchesSearch = `${id} ${name}`.toLowerCase().includes(search)
    item.classList.toggle('packet-search-hidden', !matchesSearch)
  }
}

filteringPacketSearch.addEventListener('input', updateFilteringPacketSearch)

function updateFilteringStorage () {
  setVersionSpecificVar('hiddenPackets', sharedVars.hiddenPackets)
}

function updateFilteringTab () {
  for (const item of filteringPackets.children) {
    const name = item.children[0].children[2].textContent
    //console.log(name);

    const checkbox = item.children[0].firstElementChild
    checkbox.readOnly = false
    checkbox.indeterminate = false
    let isShown = true
    if (item.className.includes('serverbound') &&
      sharedVars.hiddenPackets.serverbound.includes(name)) {
      isShown = false
    } else if (item.className.includes('clientbound') &&
      sharedVars.hiddenPackets.clientbound.includes(name)) {
      isShown = false
    }

    checkbox.checked = isShown
  }

  updateFiltering()
  updateFilteringStorage()
}

const allServerboundPackets = []
const allClientboundPackets = []
window.allServerboundPackets = allServerboundPackets
window.allClientboundPackets = allClientboundPackets

const scoreboardPackets = new Set([
  'scoreboard_display_objective',
  'scoreboard_objective',
  'scoreboard_score',
  'reset_score',
  'teams',
  'remove_objective',
  'set_display_objective',
  'set_score',
  'set_scoreboard_identity'
])

function applyFilteringPreset (preset) {
  let showPacket

  if (preset === 'toClient') {
    showPacket = (name, direction) => direction === 'clientbound'
  } else if (preset === 'toServer') {
    showPacket = (name, direction) => direction === 'serverbound'
  } else if (preset === 'scoreboard') {
    showPacket = (name) => scoreboardPackets.has(name)
  } else {
    return
  }

  sharedVars.hiddenPackets = {
    serverbound: allServerboundPackets.filter((name) => !showPacket(name, 'serverbound')),
    clientbound: allClientboundPackets.filter((name) => !showPacket(name, 'clientbound'))
  }
  updateFilteringTab()
}

function updateFilteringPackets () {
  filteringPackets.innerHTML = ''
  allServerboundPackets.length = 0
  allClientboundPackets.length = 0

  function addPacketsToFiltering (packetsObject, direction, appendTo) {
    console.log('packets', packetsObject)
    for (const key in packetsObject) {
      if (packetsObject.hasOwnProperty(key)) {
        console.log(!sharedVars.hiddenPackets[direction].includes(packetsObject[key]))
        filteringPackets.innerHTML +=
          `<li id="${packetsObject[key].replace(/"/g, '&#39;') + '-' + direction}" class="packet ${direction}">
            <label>
              <input type="checkbox" ${!sharedVars.hiddenPackets[direction].includes(packetsObject[key]) ? 'checked' : ''}
                onclick="toggleCheckbox(this, ${JSON.stringify(packetsObject[key]).replace(/"/g, '&#39;')}, '${direction}')"/>
              <span class="id">${escapeHtml(key)}</span>
              <span class="name">${escapeHtml(packetsObject[key])}</span>
            </label>
          </li>`
        console.log(key + ' -> ' + packetsObject[key])
        appendTo.push(packetsObject[key])
      }
    }
  }

  addPacketsToFiltering(sharedVars.proxyCapabilities.serverboundPackets, 'serverbound', allServerboundPackets)
  addPacketsToFiltering(sharedVars.proxyCapabilities.clientboundPackets, 'clientbound', allClientboundPackets)
  updateFilteringPacketSearch()
}

window.updateFilteringPackets = updateFilteringPackets

window.updateFilteringPackets()

// Update every 0.05 seconds
// TODO: Find a better way without updating on every packet (which causes lag)
window.setInterval(function () {
  if (sharedVars.packetsUpdated) {
    const diff = (sharedVars.packetList.parentElement.scrollHeight - sharedVars.packetList.parentElement.offsetHeight) - sharedVars.packetList.parentElement.scrollTop
    const wasScrolledToBottom = diff < 3 // If it was scrolled to the bottom or almost scrolled to the bottom
    wrappedClusterizeUpdate(sharedVars.allPacketsHTML)
    if (wasScrolledToBottom) {
      sharedVars.packetList.parentElement.scrollTop = sharedVars.packetList.parentElement.scrollHeight
      // Also update it later - hacky workaround for scroll bar being "left behind"
      setTimeout(() => {
        sharedVars.packetList.parentElement.scrollTop = sharedVars.packetList.parentElement.scrollHeight
      }, 10)
    }
    sharedVars.packetsUpdated = false
  }
}, 50)

window.closeDialog = function () { // window. stops standardjs from complaining
  // dialogOpen = false
  document.getElementById('dialog-overlay').className = 'dialog-overlay'
  document.getElementById('dialog').innerHTML = ''
}

window.resendEdited = function (id, newValue) {
  try {
    sharedVars.ipcRenderer.send('injectPacket', JSON.stringify({
      meta: sharedVars.allPackets[id].meta,
      data: JSON.parse(newValue),
      direction: sharedVars.allPackets[id].direction
    }))
  } catch (err) {
    alert('Invalid JSON')
  }
}

function editAndResend (id) {
  if (!sharedVars.proxyCapabilities.modifyPackets) {
    alert('Edit and Resend is unavailable')
    return
  }

  // dialogOpen = true
  document.getElementById('dialog-overlay').className = 'dialog-overlay active'
  document.getElementById('dialog').className = 'dialog'
  document.getElementById('dialog').innerHTML =

   `<h2>Edit and resend packet</h2>
    <textarea id="packetEditor"></textarea>
    <button style="margin-top: 16px;" onclick="resendEdited(${id}, packetEditor.getValue())">Send</button>
    <button style="margin-top: 16px;" class="bottom-button" onclick="closeDialog()">Close</button>`

  document.getElementById('packetEditor').value = JSON.stringify(sharedVars.allPackets[id].data, null, 2)

  window.packetEditor = CodeMirror.fromTextArea(document.getElementById('packetEditor'), { // window. stops standardjs from complaining
    lineNumbers: false,
    autoCloseBrackets: true,
    theme: 'darcula'
  })
}

function errorDialog (header, info, fatal) {
  // dialogOpen = true
  document.getElementById('dialog-overlay').className = 'dialog-overlay active'
  document.getElementById('dialog').className = 'dialog dialog-small error-dialog'
  document.getElementById('dialog').innerHTML =

 `<h2>${header}</h2>
  ${info}
  <br>
  <button style="margin-top: 16px;" class="bottom-button" onclick="${fatal ? 'sharedVars.ipcRenderer.send(\'relaunchApp\', \'\')' : 'closeDialog()' }">Close</button>`
}
window.errorDialog = errorDialog

function loginDialog (data) {
  // TODO: Take into account the other parameters
  /*
  {
    user_code: 'ABCDEFGH',
    device_code: '[long tokenish string]',
    verification_uri: 'https://www.microsoft.com/link',
    interval: 5,
    expires_in: 900,
    message: 'To sign in, use a web browser to open the page https://www.microsoft.com/link and enter the code ABCDEFGH to authenticate.'
  }
  */
  document.getElementById('dialog-overlay').className = 'dialog-overlay active'
  document.getElementById('dialog').className = 'dialog dialog-medium'
  document.getElementById('dialog').innerHTML =
 `<h2>This server is in online mode</h2>
  Please log in to your Microsoft account at the following URL:
  <br><br>
  <a href="https://www.microsoft.com/link" style="color: rgba(64, 128, 255, 0.8);" target="_blank" id="msaLink">microsoft.com/link</a>
  <br><br>
  and enter the code:
  <br><br>
  <code style="font-size: 200%; user-select: all;" id="msaCode">${data.user_code}</code>
  <br><br>
  pakkit does not store passwords, though it may store authentication tokens.
  <br><br>
  <button onclick="navigator.clipboard.writeText(document.getElementById('msaCode').innerText); document.getElementById('msaLink').click()" type="button">Open in browser and copy code</button>`
}

sharedVars.ipcRenderer.on('showAuthCode', (event, arg) => {
  const ipcMessage = JSON.parse(arg)
  if (ipcMessage === 'close') {
    window.closeDialog()
  } else {
    loginDialog(ipcMessage)
  }
})

sharedVars.ipcRenderer.on('editAndResend', (event, arg) => {
  const ipcMessage = JSON.parse(arg)
  editAndResend(ipcMessage.id)
})

function deselectPacket () {
  closeDataFind()
  if (currentPacket) {
    removeOrAddSelection(currentPacket, false)
  }
  currentPacket = undefined
  currentPacketType = undefined
  sharedVars.packetDom.getTreeElement().firstElementChild.innerHTML = 'No packet selected!'
  document.body.classList.remove('packetSelected')
  document.body.classList.add('noPacketSelected')
  hexViewer.style.display = 'none'
  apolloButton.hidden = true
  apolloDecodeRequest++
  if (apolloViewerActive) openDataView({ currentTarget: dataButton })
}
window.deselectPacket = deselectPacket

window.clearPackets = function () { // window. stops standardjs from complaining
  deselectPacket()
  sharedVars.allPackets = []
  sharedVars.allPacketsHTML = []
  apolloResults.clear()
  sharedVars.packetsUpdated = true
  // TODO: Doesn't seem to work? When removing line above it doesn't do anything until the next packet
  wrappedClusterizeUpdate([])
}

window.showAllPackets = function () { // window. stops standardjs from complaining
  sharedVars.hiddenPackets = {
    serverbound: [], clientbound: []
  }
  updateFilteringTab()
}

const hexViewer = document.getElementById('hex-viewer')
const hexButton = document.getElementById('hex-button')
const dataButton = document.getElementById('data-button')
const apolloButton = document.getElementById('apollo-button')
const apolloElement = document.getElementById('apollo')
const apolloTree = jsonTree.create({}, apolloElement)
const dataFind = document.getElementById('data-find')
const dataFindInput = document.getElementById('data-find-input')
const dataFindCount = document.getElementById('data-find-count')
let hexViewerActive = false
let hexViewerLoaded = false
let apolloViewerActive = false
let apolloDecodeRequest = 0
const apolloResults = new Map()
let dataFindMatches = []
let dataFindMatchIndex = -1
let dataFindTimer

if (!sharedVars.proxyCapabilities.rawData) {
  hexButton.style.display = 'none'
}

function renderCurrentPacketInHexViewer () {
  if (!hexViewerActive || !hexViewerLoaded || currentPacket === undefined) return

  const packet = sharedVars.allPackets[currentPacket]
  if (!packet || !packet.raw) return

  const buf = Uint8Array.from(packet.raw)
  hexViewer.style.display = 'block'
  hexViewer.contentWindow.postMessage(buf.buffer, '*', [buf.buffer])
}

hexViewer.addEventListener('load', () => {
  if (!hexViewer.getAttribute('src')) return

  hexViewerLoaded = true
  renderCurrentPacketInHexViewer()
})

function openDataView (event) {
  hexViewerActive = false
  apolloViewerActive = false
  window.openMenu(event, 'tree', '-rightpanel')
}

function openHexView (event) {
  closeDataFind()
  hexViewerActive = true
  apolloViewerActive = false
  window.openMenu(event, 'hex', '-rightpanel')

  if (!hexViewer.getAttribute('src')) {
    hexViewer.src = hexViewer.dataset.src
  } else {
    renderCurrentPacketInHexViewer()
  }
}

function isApolloPacket (packet) {
  return packet?.meta?.name === 'custom_payload' && packet?.data?.channel === 'lunar:apollo'
}

function loadApolloTree (data) {
  apolloTree.loadData(data)
  apolloTree.expand()
}

async function decodeApolloPacket (packetId) {
  if (apolloResults.has(packetId)) return apolloResults.get(packetId)

  const packet = sharedVars.allPackets[packetId]
  if (!isApolloPacket(packet)) throw new Error('This is not a lunar:apollo packet')

  const decoded = await sharedVars.ipcRenderer.invoke('decodeApolloPayload', JSON.stringify({
    payload: packet.data.data
  }))
  apolloResults.set(packetId, decoded)
  return decoded
}

sharedVars.ipcRenderer.on('copyApolloData', async (event, arg) => {
  const { id } = JSON.parse(arg)
  try {
    const decoded = await decodeApolloPacket(Number(id))
    sharedVars.ipcRenderer.send('copyToClipboard', JSON.stringify(decoded, null, 2))
  } catch (error) {
    window.errorDialog('Could not copy Apollo data', error.message, false)
  }
})

async function renderCurrentPacketInApolloViewer () {
  if (!apolloViewerActive || currentPacket === undefined) return

  const packetId = currentPacket
  const packet = sharedVars.allPackets[packetId]
  if (!isApolloPacket(packet)) return

  if (apolloResults.has(packetId)) {
    loadApolloTree(apolloResults.get(packetId))
    return
  }

  const request = ++apolloDecodeRequest
  loadApolloTree({ status: 'Loading the Apollo protobuf schema…' })

  try {
    const decoded = await decodeApolloPacket(packetId)
    if (request !== apolloDecodeRequest || currentPacket !== packetId || !apolloViewerActive) return

    loadApolloTree(decoded)
  } catch (error) {
    if (request !== apolloDecodeRequest || currentPacket !== packetId || !apolloViewerActive) return
    loadApolloTree({ error: error.message })
  }
}

function openApolloView (event) {
  closeDataFind()
  hexViewerActive = false
  apolloViewerActive = true
  window.openMenu(event, 'apollo', '-rightpanel')
  renderCurrentPacketInApolloViewer()
}

function isDataViewActive () {
  return sharedVars.proxyCapabilities.jsonData &&
    currentPacket !== undefined &&
    document.getElementById('tree').style.display !== 'none'
}

function collectDataFindMatches (value, query, path = [], matches = []) {
  if (value === null || typeof value !== 'object') return matches

  for (const key of Object.keys(value)) {
    const child = value[key]
    const childPath = path.concat(Array.isArray(value) ? Number(key) : key)
    const labelMatches = String(key).toLowerCase().includes(query)
    const valueMatches = child === null || typeof child !== 'object'
      ? String(child).toLowerCase().includes(query)
      : false

    if (labelMatches || valueMatches) matches.push(childPath)
    if (child !== null && typeof child === 'object') {
      collectDataFindMatches(child, query, childPath, matches)
    }
  }

  return matches
}

function getDataFindNode (path) {
  let node = sharedVars.packetDom.getTree().rootNode

  for (const label of path) {
    if (!node || !node.isComplex) return
    node.expand()
    node = node.childNodes.find((child) => String(child.label) === String(label))
  }

  return node
}

function showDataFindMatch (index) {
  document.querySelector('.jsontree_node.data-find-current')?.classList.remove('data-find-current')

  if (dataFindMatches.length === 0) {
    dataFindMatchIndex = -1
    dataFindCount.textContent = '0/0'
    return
  }

  dataFindMatchIndex = (index + dataFindMatches.length) % dataFindMatches.length
  dataFindCount.textContent = `${dataFindMatchIndex + 1}/${dataFindMatches.length}`

  const node = getDataFindNode(dataFindMatches[dataFindMatchIndex])
  if (!node) return

  node.el.classList.add('data-find-current')
  node.el.scrollIntoView({ block: 'center' })
}

function updateDataFindResults () {
  clearTimeout(dataFindTimer)
  document.querySelector('.jsontree_node.data-find-current')?.classList.remove('data-find-current')

  const query = dataFindInput.value.trim().toLowerCase()
  if (!query || currentPacket === undefined) {
    dataFindMatches = []
    showDataFindMatch(-1)
    return
  }

  const tree = sharedVars.packetDom.getTree()
  dataFindMatches = collectDataFindMatches(tree.sourceJSONObj, query)
  showDataFindMatch(0)
}

function scheduleDataFindUpdate () {
  clearTimeout(dataFindTimer)
  dataFindTimer = setTimeout(updateDataFindResults, 120)
}

function openDataFind () {
  if (!isDataViewActive()) return

  dataFind.hidden = false
  dataFindInput.focus()
  dataFindInput.select()
  updateDataFindResults()
}

function closeDataFind () {
  clearTimeout(dataFindTimer)
  dataFind.hidden = true
  document.querySelector('.jsontree_node.data-find-current')?.classList.remove('data-find-current')
}

dataFindInput.addEventListener('input', scheduleDataFindUpdate)
dataFindInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    showDataFindMatch(dataFindMatchIndex + (event.shiftKey ? -1 : 1))
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeDataFind()
  }
})
document.getElementById('data-find-previous').addEventListener('click', () => showDataFindMatch(dataFindMatchIndex - 1))
document.getElementById('data-find-next').addEventListener('click', () => showDataFindMatch(dataFindMatchIndex + 1))
document.getElementById('data-find-close').addEventListener('click', closeDataFind)
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && isDataViewActive()) {
    event.preventDefault()
    openDataFind()
  }
})

function removeOrAddSelection (id, add) {
  const fakeElement = document.createElement('div')
  fakeElement.innerHTML = sharedVars.allPacketsHTML[id][0]
  if (add) {
    fakeElement.firstChild.classList.add('selected')
  } else {
    fakeElement.firstChild.classList.remove('selected')
  }
  sharedVars.allPacketsHTML[id] = [fakeElement.innerHTML]

  wrappedClusterizeUpdate(sharedVars.allPacketsHTML)
  clusterize.refresh()
}

window.packetClick = function (id) { // window. stops standardjs from complaining
  // Remove selection background from old selected packet
  if (currentPacket !== undefined) {
    removeOrAddSelection(currentPacket, false)
  }

  currentPacket = id
  const packet = sharedVars.allPackets[id]
  const apolloPacket = isApolloPacket(packet)
  apolloButton.hidden = !apolloPacket
  apolloDecodeRequest++
  if (!apolloPacket && apolloViewerActive) openDataView({ currentTarget: dataButton })
  // const element = document.getElementById('packet' + id)
  currentPacketType = sharedVars.allPackets[id].name
  removeOrAddSelection(currentPacket, true)
  document.body.classList.remove('noPacketSelected')
  document.body.classList.add('packetSelected')
  if (sharedVars.proxyCapabilities.jsonData) {
    // sidebar.innerHTML = '<div style="padding: 10px;">Loading packet data...</div>';
    if (sharedVars.allPackets[id].data === undefined) {
      sharedVars.packetDom.getTreeElement().firstElementChild.innerHTML = 'Could not parse packet'
      // TODO: Error message
    } else {
      const tree = sharedVars.packetDom.getTree()
      tree.loadData(sharedVars.allPackets[id].data)
      if (packet.meta.name !== 'map_chunk' && packet.meta.name !== 'map_chunk_bulk') {
        tree.expand()
      }
      if (!dataFind.hidden) updateDataFindResults()
    }
  } else {
    sharedVars.packetDom.getTreeElement().innerText = sharedVars.allPackets[id].data.data
    sharedVars.packetDom.getTreeElement().style = `
    color: #0F0;
    white-space: pre;
    font-family: 'PT Mono', monospace;
    font-size: 14px;
    display: block;`
  }

  if (sharedVars.proxyCapabilities.rawData) {
    renderCurrentPacketInHexViewer()
  }

  if (apolloViewerActive) renderCurrentPacketInApolloViewer()
}

function hideAll (id) {
  const packet = sharedVars.allPackets[id]
  if (sharedVars.hiddenPackets[packet.direction].indexOf(packet.meta.name) === -1) {
    sharedVars.hiddenPackets[packet.direction].push(packet.meta.name)
  }
  const packetElement = document.getElementById(packet.meta.name + '-' + packet.direction)
  if (packetElement) {
    const checkbox = packetElement.firstElementChild
    checkbox.checked = false
    checkbox.readOnly = false
    checkbox.indeterminate = false
  }
  deselectPacket()
  updateFiltering()
  updateFilteringStorage()
}

sharedVars.ipcRenderer.on('hideAllOfType', (event, arg) => { // Context menu
  const ipcMessage = JSON.parse(arg)
  hideAll(ipcMessage.id)
})

// Modified from W3Schools
window.openMenu = function (evt, MenuName, id) { // window. stops standardjs from complaining
  let i, tabcontent, tablinks
  tabcontent = document.getElementsByClassName('tabcontent' + id)
  for (i = 0; i < tabcontent.length; i++) {
    tabcontent[i].style.display = 'none'
  }
  tablinks = document.getElementsByClassName('tablinks' + id)
  for (i = 0; i < tablinks.length; i++) {
    tablinks[i].className = tablinks[i].className.replace(' active', '')
  }
  document.getElementById(MenuName).style.display = 'block'
  evt.currentTarget.className += ' active'
}

document.body.addEventListener('contextmenu', (event) => {
  if (event.srcElement === null) return

  let target = event.srcElement

  let attempts = 0
  while (target !== null && target.tagName !== 'LI' && attempts < 5) {
    target = target.parentElement
    attempts++
  }

  if (!target || target.tagName !== 'LI') {
    return
  }

  // Don't allow right clicking in the filtering tab or on other places
  if (target.parentElement.parentElement.id !== 'packetcontainer') {
    return
  }

  const id = target.id.replace('packet', '')
  const packet = sharedVars.allPackets[Number(id)]
  sharedVars.ipcRenderer.send('contextMenu', JSON.stringify({
    direction: target.className.split(' ')[1],
    text: target.children[0].children[0].innerText + ' ' + target.children[0].children[1].innerText,
    id: id,
    invalid: target.classList.contains('invalid'),
    noData: packet.data === undefined,
    apollo: isApolloPacket(packet)
  }))
})

var clusterize = new Clusterize({
  rows: sharedVars.allPacketsHTML,
  scrollElem: sharedVars.packetList.parentElement,
  contentElem: sharedVars.packetList,
  no_data_text: ''
})

function saveLog () {
  sharedVars.ipcRenderer.send('saveLog', JSON.stringify(sharedVars.allPackets))
}

function loadLog () {
  sharedVars.ipcRenderer.send('loadLog', '')
}

function saveScript (newfile = true) {
  if (newfile) {
    sharedVars.ipcRenderer.send('saveAsScript', window.scriptEditor.getDoc().getValue())
  } else {
    sharedVars.ipcRenderer.send('saveScript', window.scriptEditor.getDoc().getValue())
  }
}

function loadScript () {
  sharedVars.ipcRenderer.send('loadScript', '')
}

// Expose handlers referenced from inline HTML attributes (module scope is not global)
window.currentPacket = null
Object.defineProperty(window, 'currentPacket', {
  get: () => currentPacket,
  set: (v) => { currentPacket = v }
})
window.toggleCheckbox = toggleCheckbox
window.updateFilterBox = updateFilterBox
window.updateFilteringTab = updateFilteringTab
window.applyFilteringPreset = applyFilteringPreset
window.openDataView = openDataView
window.openHexView = openHexView
window.openApolloView = openApolloView
window.getVersionSpecificVar = getVersionSpecificVar
window.findDefault = findDefault
window.findPreset = findPreset
window.editAndResend = editAndResend
window.hideAll = hideAll
window.saveLog = saveLog
window.loadLog = loadLog
window.saveScript = saveScript
window.loadScript = loadScript
