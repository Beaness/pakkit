import settingsJson from './settings.json'

const settingsElement = document.getElementById('settings-list')

let sharedVars

const changeFunctions = {}
// Prevents constant file reads/writes
const cache = {}

export function bindToSettingChange (settingId, f) {
  changeFunctions[settingId] = f
}

export function getSetting (id) {
  if (cache[id] === undefined) {
    if (sharedVars.store.get('settings.' + id) === undefined) {
      sharedVars.store.set('settings.' + id, settingsJson[id].default)
    }
    cache[id] = sharedVars.store.get('settings.' + id)
  }
  return cache[id]
}

export function setSetting (settingId, value) {
  cache[settingId] = value
  sharedVars.store.set('settings.' + settingId, value)
  if (changeFunctions[settingId]) {
    changeFunctions[settingId](value)
  }
}

window.setSetting = setSetting

function createToggle (settingId) {
  const toggleElement = document.createElement('label')
  toggleElement.className = 'switch'

  const input = document.createElement('input')
  input.id = settingId
  input.type = 'checkbox'
  input.checked = getSetting(settingId)
  input.addEventListener('change', () => {
    setSetting(settingId, input.checked)
  })
  toggleElement.appendChild(input)

  const slider = document.createElement('span')
  slider.className = 'slider round'
  toggleElement.appendChild(slider)

  return toggleElement
}

export function setup (passedSharedVars) {
  sharedVars = passedSharedVars

  for (const settingId in settingsJson) {
    if (!settingsJson.hasOwnProperty(settingId)) continue

    const setting = settingsJson[settingId]

    const element = document.createElement('section')
    element.id = settingId
    element.className = 'setting-card'

    const textElement = document.createElement('div')
    textElement.className = 'setting-copy'

    const nameElement = document.createElement('h2')
    nameElement.textContent = setting.name
    nameElement.className = 'settingName'
    textElement.appendChild(nameElement)

    const descriptionElement = document.createElement('p')
    descriptionElement.textContent = setting.description
    descriptionElement.className = 'settingDescription'
    textElement.appendChild(descriptionElement)
    element.appendChild(textElement)

    switch (setting.type) {
      case 'boolean':
        element.appendChild(createToggle(settingId))
        break
      default:
        console.error('Unknown setting type', setting.type)
    }

    settingsElement.appendChild(element)

    // Call change function
    if (changeFunctions[settingId]) {
      changeFunctions[settingId](getSetting(settingId))
    }
  }
}
