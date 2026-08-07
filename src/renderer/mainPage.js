/* global Split, jsonTree, escapeHtml, alert, CodeMirror */

import Clusterize from 'clusterize.js'
import { syncStatusVisibility } from './errorHandler.js'
import defaultsJson from './defaults.json'
import * as scripting from './scripting.js'
import * as packetDom from './packetDom.js'
import * as ipcHandler from './ipcHandler.js'
import * as settings from './settings.js'
import * as bandwidth from './bandwidth.js'
import { formatHexDump } from './hexDump.js'
import { appendVisiblePacketRows } from './visiblePacketRows.mjs'
import { createPacketFailureView } from './packetFailureView.mjs'

let currentPacket
let currentPacketType

const filterInput = document.getElementById('filter')
const packetContainer = document.getElementById('packetcontainer')

const hiddenPacketsCounter = document.getElementById('hiddenPackets')
const showAllPacketsButton = document.getElementById('showAllPacketsButton')
const packetCount = document.getElementById('packetCount')
const copySelectedPacketButton = document.getElementById('copySelectedPacketButton')
const editAndResendButton = document.getElementById('editAndResend')

const filterWorker = new Worker(new URL('./filterWorker.js', import.meta.url), { type: 'module' })

let clusterize
let filterRevision = 0
let filterResultPending = false
let filterPacketFlushTimer
let visiblePacketFlushTimer
let pendingFilterPackets = []
let pendingVisiblePacketRows = []
const visibleAfterFilterSnapshot = new Set()

function updatePacketSummary () {
  const packetTotal = sharedVars.allPackets.length
  packetCount.textContent = `${packetTotal.toLocaleString()} ${packetTotal === 1 ? 'packet' : 'packets'}`
  packetCount.setAttribute('aria-label', `${packetTotal} captured packets`)
  hiddenPacketsCounter.textContent = sharedVars.hiddenPacketsAmount + ' hidden packets'
  hiddenPacketsCounter.classList.toggle('visible', sharedVars.hiddenPacketsAmount !== 0)
  showAllPacketsButton.hidden = sharedVars.hiddenPacketsAmount === 0
}

function filterOptions (type) {
  return {
    type,
    revision: filterRevision,
    query: sharedVars.lastFilter,
    inverseFiltering: sharedVars.settings.getSetting('inverseFiltering'),
    regexFilter: sharedVars.settings.getSetting('regexFilter'),
    hiddenPackets: sharedVars.hiddenPackets
  }
}

function flushFilterPacketQueue () {
  if (filterPacketFlushTimer !== undefined) {
    clearTimeout(filterPacketFlushTimer)
    filterPacketFlushTimer = undefined
  }
  if (pendingFilterPackets.length === 0) return

  const packets = pendingFilterPackets
  pendingFilterPackets = []
  filterWorker.postMessage({ type: 'add', packets })
}

function queuePacketForFiltering (packet) {
  pendingFilterPackets.push({
    uid: packet.uid,
    direction: packet.direction,
    name: packet.meta.name,
    hexIdString: packet.hexIdString,
    data: packet.data
  })

  if (filterPacketFlushTimer === undefined) {
    filterPacketFlushTimer = window.setTimeout(flushFilterPacketQueue, 16)
  }
}

function wasPacketListScrolledToBottom () {
  const scrollElement = sharedVars.packetList.parentElement
  const diff = (scrollElement.scrollHeight - scrollElement.offsetHeight) - scrollElement.scrollTop
  return diff < 3
}

function keepPacketListAtBottom () {
  const scrollElement = sharedVars.packetList.parentElement
  scrollElement.scrollTop = scrollElement.scrollHeight
  window.setTimeout(() => {
    scrollElement.scrollTop = scrollElement.scrollHeight
  }, 10)
}

function flushVisiblePacketRows () {
  visiblePacketFlushTimer = undefined
  if (pendingVisiblePacketRows.length === 0) {
    updatePacketSummary()
    return
  }

  const wasScrolledToBottom = wasPacketListScrolledToBottom()
  const rows = pendingVisiblePacketRows
  pendingVisiblePacketRows = []

  appendVisiblePacketRows(
    sharedVars.visiblePacketsHTML,
    rows,
    newRows => clusterize.append(newRows)
  )
  updatePacketSummary()

  if (wasScrolledToBottom) keepPacketListAtBottom()
}

function scheduleVisiblePacketFlush () {
  if (visiblePacketFlushTimer !== undefined) return
  visiblePacketFlushTimer = window.setTimeout(flushVisiblePacketRows, 50)
}

function queueVisiblePacketIds (visibleIds) {
  for (const id of visibleIds) {
    const row = sharedVars.allPacketsHTML[id]
    if (!row) continue
    pendingVisiblePacketRows.push(row)
  }
  scheduleVisiblePacketFlush()
}

function cancelPendingVisibleRows () {
  if (visiblePacketFlushTimer !== undefined) {
    clearTimeout(visiblePacketFlushTimer)
    visiblePacketFlushTimer = undefined
  }
  pendingVisiblePacketRows = []
}

function applyFilterResult (message) {
  const { revision, packetCount: indexedPacketCount, visibleIds } = message
  const nextRows = []
  let index = 0

  function materializeChunk () {
    if (revision !== filterRevision) return

    const deadline = performance.now() + 8
    while (index < visibleIds.length && performance.now() < deadline) {
      const id = visibleIds[index++]
      const row = sharedVars.allPacketsHTML[id]
      if (!row) continue
      nextRows.push(row)
    }

    if (index < visibleIds.length) {
      window.setTimeout(materializeChunk, 0)
      return
    }

    const appendedIds = [...visibleAfterFilterSnapshot]
      .filter((id) => id >= indexedPacketCount)
      .sort((a, b) => a - b)
    for (const id of appendedIds) {
      const row = sharedVars.allPacketsHTML[id]
      if (!row) continue
      nextRows.push(row)
    }

    cancelPendingVisibleRows()
    sharedVars.visiblePacketsHTML = nextRows
    visibleAfterFilterSnapshot.clear()
    filterResultPending = false
    clusterize.update(nextRows)
    updatePacketSummary()
  }

  materializeChunk()
}

filterWorker.addEventListener('message', (event) => {
  const message = event.data
  if (message.revision !== filterRevision) return

  sharedVars.hiddenPacketsAmount = message.hiddenCount

  if (message.type === 'filterResult') {
    applyFilterResult(message)
  } else if (message.type === 'appendResult') {
    if (filterResultPending) {
      for (const id of message.visibleIds) visibleAfterFilterSnapshot.add(id)
      updatePacketSummary()
    } else {
      queueVisiblePacketIds(message.visibleIds)
    }
  }
})

filterWorker.addEventListener('error', (event) => {
  console.error('Packet filtering worker failed', event.error || event.message)
})

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
  flushFilterPacketQueue()
  filterRevision++
  filterResultPending = true
  visibleAfterFilterSnapshot.clear()
  cancelPendingVisibleRows()
  filterWorker.postMessage(filterOptions('filter'))
}

filterInput.addEventListener('input', updateFilterBox)

const sharedVars = {
  allPackets: [],
  allPacketsHTML: [],
  visiblePacketsHTML: [],
  proxyCapabilities: {},
  ipcRenderer: window.ipcRenderer,
  packetList: document.getElementById('packetlist'),
  hiddenPackets: undefined,
  scripting: undefined,
  lastFilter: '',
  hiddenPacketsAmount: 0,
  queuePacketForFiltering,
  resetPacketFiltering: undefined,
  store: window.store
}

window.sharedVars = sharedVars

function resetPacketFiltering () {
  filterRevision++
  filterResultPending = false
  visibleAfterFilterSnapshot.clear()
  cancelPendingVisibleRows()

  if (filterPacketFlushTimer !== undefined) {
    clearTimeout(filterPacketFlushTimer)
    filterPacketFlushTimer = undefined
  }
  pendingFilterPackets = []

  sharedVars.visiblePacketsHTML = []
  sharedVars.hiddenPacketsAmount = 0
  filterWorker.postMessage(filterOptions('reset'))

  if (clusterize) clusterize.clear()
  updatePacketSummary()
}

sharedVars.resetPacketFiltering = resetPacketFiltering

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
  const name = elem.dataset.preset
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
  e.className = 'filter-chip'
  e.type = 'button'
  e.dataset.preset = Object.keys(value)[0]
  e.innerText = Object.keys(value)[0].replace(/_/g, ' ')
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
sharedVars.bandwidth = bandwidth
sharedVars.bandwidth.setup(sharedVars)
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
const filteringAutoEmpty = document.getElementById('filtering-auto-empty')

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

  const waitingForAutomaticVersion = sharedVars.proxyCapabilities.versionId === 'java-node-minecraft-protocol-auto'
  filteringAutoEmpty.hidden = !waitingForAutomaticVersion
  filteringPackets.hidden = waitingForAutomaticVersion
  document.querySelectorAll('#Filtering button, #filtering-packet-search').forEach((element) => {
    element.disabled = waitingForAutomaticVersion
  })

  if (waitingForAutomaticVersion) return

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

// Clusterize can replace a row between pointer-down and click while packets are
// arriving. Select from the stable container on pointer-down so a single press
// is reliable even while the list is autoscrolling.
packetContainer.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return

  const packetElement = event.target.closest('.packet[data-packet-id]')
  if (!packetElement || !packetContainer.contains(packetElement)) return

  window.packetClick(Number(packetElement.dataset.packetId))
})

window.closeDialog = function () { // window. stops standardjs from complaining
  if (window.packetEditor) {
    window.packetEditor.toTextArea()
    delete window.packetEditor
  }
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
    window.closeDialog()
  } catch (err) {
    const errorMessage = document.getElementById('packetEditorError')
    if (errorMessage) {
      errorMessage.textContent = 'The packet data is not valid JSON. Check the highlighted structure and try again.'
      errorMessage.hidden = false
    } else {
      alert('Invalid JSON')
    }
  }
}

function editAndResend (id) {
  if (!sharedVars.proxyCapabilities.modifyPackets) {
    alert('Edit and Resend is unavailable')
    return
  }

  const packet = sharedVars.allPackets[id]
  const dialogOverlay = document.getElementById('dialog-overlay')
  const dialog = document.getElementById('dialog')
  dialogOverlay.className = 'dialog-overlay active'
  dialog.className = 'dialog packet-editor-dialog'
  dialog.innerHTML = `
    <header class="dialog-header">
      <div>
        <p class="eyebrow">Edit packet</p>
        <div class="dialog-title-row">
          <h2 id="packetEditorTitle"></h2>
          <span class="direction-badge" id="packetEditorDirection"></span>
        </div>
        <p class="dialog-description">Change the JSON data, then send a new copy in the same direction.</p>
      </div>
      <button aria-label="Close editor" class="button-quiet icon-button dialog-close" id="packetEditorClose" title="Close" type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div class="packet-editor-frame"><textarea id="packetEditor"></textarea></div>
    <footer class="dialog-footer">
      <p class="packet-editor-error" hidden id="packetEditorError" role="alert"></p>
      <div class="button-group">
        <button class="button-quiet" id="packetEditorCancel" type="button">Cancel</button>
        <button class="primary-button" id="packetEditorSend" type="button">Send packet</button>
      </div>
    </footer>`

  document.getElementById('packetEditorTitle').textContent = packet.meta.name
  const directionBadge = document.getElementById('packetEditorDirection')
  directionBadge.textContent = packet.direction
  directionBadge.classList.add(packet.direction)
  document.getElementById('packetEditor').value = JSON.stringify(packet.data, null, 2)

  window.packetEditor = CodeMirror.fromTextArea(document.getElementById('packetEditor'), { // window. stops standardjs from complaining
    lineNumbers: true,
    autoCloseBrackets: true,
    mode: { name: 'javascript', json: true },
    indentUnit: 2,
    tabSize: 2,
    theme: 'darcula',
    extraKeys: {
      'Ctrl-Enter': () => window.resendEdited(id, window.packetEditor.getValue()),
      'Cmd-Enter': () => window.resendEdited(id, window.packetEditor.getValue())
    }
  })
  document.getElementById('packetEditorClose').addEventListener('click', window.closeDialog)
  document.getElementById('packetEditorCancel').addEventListener('click', window.closeDialog)
  document.getElementById('packetEditorSend').addEventListener('click', () => {
    window.resendEdited(id, window.packetEditor.getValue())
  })
  window.packetEditor.focus()
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
  if (currentPacket !== undefined) {
    removeOrAddSelection(currentPacket, false)
  }
  currentPacket = undefined
  currentPacketType = undefined
  document.getElementById('selectedPacketName').textContent = 'Packet details'
  sharedVars.packetDom.getTreeElement().firstElementChild.innerHTML = 'No packet selected!'
  document.body.classList.remove('packetSelected')
  document.body.classList.add('noPacketSelected')
  hexViewer.textContent = ''
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
  resetPacketFiltering()
  sharedVars.bandwidth.reset()
}

window.showAllPackets = function () { // window. stops standardjs from complaining
  filterInput.value = ''
  sharedVars.lastFilter = ''
  sharedVars.hiddenPackets = {
    serverbound: [], clientbound: []
  }
  updateFilteringTab()
}
showAllPacketsButton.addEventListener('click', window.showAllPackets)

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
  if (!hexViewerActive || currentPacket === undefined) return

  const packet = sharedVars.allPackets[currentPacket]
  if (!packet) return

  hexViewer.textContent = formatHexDump(packet.raw)
  hexViewer.scrollTo(0, 0)
}

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
  renderCurrentPacketInHexViewer()
}

function isApolloPacket (packet) {
  return packet?.meta?.name === 'custom_payload' && packet?.data?.channel === 'lunar:apollo'
}

function loadApolloTree (data) {
  apolloTree.loadData(data)
  apolloTree.expand()
  if (!dataFind.hidden && apolloViewerActive) updateDataFindResults()
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

function getActiveDataFindTree () {
  if (currentPacket === undefined) return

  if (apolloViewerActive && isApolloPacket(sharedVars.allPackets[currentPacket])) {
    return apolloTree
  }

  if (!hexViewerActive && !apolloViewerActive && sharedVars.proxyCapabilities.jsonData) {
    return sharedVars.packetDom.getTree()
  }
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
  let node = getActiveDataFindTree()?.rootNode

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

  const tree = getActiveDataFindTree()
  if (!tree) {
    dataFindMatches = []
    showDataFindMatch(-1)
    return
  }
  dataFindMatches = collectDataFindMatches(tree.sourceJSONObj, query)
  showDataFindMatch(0)
}

function scheduleDataFindUpdate () {
  clearTimeout(dataFindTimer)
  dataFindTimer = setTimeout(updateDataFindResults, 120)
}

function openDataFind () {
  if (!getActiveDataFindTree()) return

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
  const packetsViewActive = document.querySelector('.tablinks-topmenu.active')?.getAttribute('aria-controls') === 'Packets'

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && packetsViewActive && getActiveDataFindTree()) {
    event.preventDefault()
    openDataFind()
    return
  }

  const isTyping = event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement || event.target.isContentEditable

  if (event.key === '/' && !isTyping && packetsViewActive) {
    event.preventDefault()
    filterInput.focus()
    filterInput.select()
  } else if (event.key === 'Escape' && document.activeElement === filterInput && filterInput.value) {
    filterInput.value = ''
    updateFilterBox()
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
  // Visible rows hold this same one-item array. Mutating it lets Clusterize
  // refresh only the rendered cluster instead of rebuilding the full list.
  sharedVars.allPacketsHTML[id][0] = fakeElement.innerHTML
  clusterize.refresh(true)
}

window.packetClick = function (id) { // window. stops standardjs from complaining
  // Remove selection background from old selected packet
  if (currentPacket !== undefined) {
    removeOrAddSelection(currentPacket, false)
  }

  currentPacket = id
  const packet = sharedVars.allPackets[id]
  copySelectedPacketButton.disabled = packet.data === undefined
  editAndResendButton.disabled = packet.data === undefined
  const apolloPacket = isApolloPacket(packet)
  apolloButton.hidden = !apolloPacket
  apolloDecodeRequest++
  if (!apolloPacket && apolloViewerActive) openDataView({ currentTarget: dataButton })
  // const element = document.getElementById('packet' + id)
  currentPacketType = sharedVars.allPackets[id].name
  document.getElementById('selectedPacketName').textContent = packet.meta.name
  removeOrAddSelection(currentPacket, true)
  document.body.classList.remove('noPacketSelected')
  document.body.classList.add('packetSelected')
  if (sharedVars.proxyCapabilities.jsonData) {
    // sidebar.innerHTML = '<div style="padding: 10px;">Loading packet data...</div>';
    if (sharedVars.allPackets[id].data === undefined) {
      const tree = sharedVars.packetDom.getTree()
      tree.loadData(createPacketFailureView(packet))
      tree.expand()
      if (!dataFind.hidden) updateDataFindResults()
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

function copySelectedPacket () {
  if (currentPacket === undefined) return

  let data = sharedVars.allPackets[currentPacket].data
  if (data === undefined) return
  data = sharedVars.proxyCapabilities.jsonData ? JSON.stringify(data, null, 2) : data.data
  sharedVars.ipcRenderer.send('copyToClipboard', data)
}

function editSelectedPacket () {
  if (currentPacket === undefined) return
  editAndResend(currentPacket)
}

function hideSelectedPacketType () {
  if (currentPacket === undefined) return
  hideAll(currentPacket)
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
    tablinks[i].setAttribute('aria-selected', 'false')
  }
  document.getElementById(MenuName).style.display = 'block'
  evt.currentTarget.className += ' active'
  evt.currentTarget.setAttribute('aria-selected', 'true')

  if (id === '-topmenu') {
    document.querySelector('.container').inert = MenuName !== 'Packets'
    if (MenuName === 'Bandwidth') sharedVars.bandwidth.viewOpened()
    syncStatusVisibility()
  }
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

clusterize = new Clusterize({
  rows: sharedVars.visiblePacketsHTML,
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
window.copySelectedPacket = copySelectedPacket
window.editSelectedPacket = editSelectedPacket
window.hideSelectedPacketType = hideSelectedPacketType
window.saveLog = saveLog
window.loadLog = loadLog
window.saveScript = saveScript
window.loadScript = loadScript
