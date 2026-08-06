let tree
let treeElement
let sharedVars

function trimData (data) { // Function to trim the size of stringified data for previews
  if (data === undefined) {
    // Undefined data, probably an invalid packet
    return 'Could not parse packet'
  }

  let newData
  if (sharedVars.proxyCapabilities.jsonData) {
    newData = Object.assign({}, data)
    Object.entries(newData).forEach(function (entry) {
      try {
        if (JSON.stringify(entry[1]).length > 15) {
          if (typeof entry[1] === 'number') {
            newData[entry[0]] = Math.round((entry[1] + Number.EPSILON) * 100) / 100
          } else {
            newData[entry[0]] = '...'
          }
        }
      } catch (err) {

      }
    })
    newData = JSON.stringify(newData)
  } else {
    newData = data.data
  }
  if (newData.length > 750) {
    newData = newData.slice(0, 750)
  }
  return newData
}

function formatTime (ms) {
  // Based on https://stackoverflow.com/a/50409993/4012708
  return new Date(new Date(ms).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[1].replace(/[0-9]Z$/, '')
}

export function addPacketToDOM (packet) {
  sharedVars.allPacketsHTML.push([
    `<li id="packet${packet.uid}" data-packet-id="${packet.uid}" class="packet ${packet.direction} filter-shown ${packet.packetValid ? '' : 'invalid'}">
        <div class="main-data">
          <span class="id">${escapeHtml(packet.hexIdString)}</span>
          <span class="name">${escapeHtml(packet.meta.name)}</span>
          <span class="data">${escapeHtml(trimData(packet.data))}</span>
        </div>
        <span class="time">${escapeHtml(formatTime(packet.time))}</span>
      </li>`])

  sharedVars.queuePacketForFiltering(packet)
}

function refreshPackets () {
  // TODO: Is this needed?
}

export function setup (passedSharedVars) {
  sharedVars = passedSharedVars

  treeElement = document.getElementById('tree')
  tree = jsonTree.create({}, treeElement)

  treeElement.firstElementChild.innerHTML = 'No packet selected!'
}

export function addPacket (data) {
  sharedVars.allPackets.push(data)
  data.uid = sharedVars.allPackets.length - 1
  addPacketToDOM(data)
}

// TODO: use shared var

export function getTreeElement () {
  return treeElement
}

export function getTree () {
  return tree
}
