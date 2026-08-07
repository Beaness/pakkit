const errorDiv = document.getElementById('error')

function scriptingTabIsOpen () {
  const scriptingTab = document.getElementById('Scripting')
  return scriptingTab && scriptingTab.style.display === 'block'
}

export function syncStatusVisibility () {
  errorDiv.hidden = errorDiv.dataset.statusSource === 'script' && !scriptingTabIsOpen()
}

// https://developer.mozilla.org/en-US/docs/Web/API/GlobalEventHandlers/onerror
export function handleError (stack) {
  // Reformat message
  const split = String(stack || 'Unknown error').split(' at ')
  split[0] = split[0].split('\n').join(' ').trim() + '\n'

  errorDiv.classList.remove('success')
  errorDiv.dataset.statusSource = 'application'
  errorDiv.innerText = split.slice(0, 2).join(' at ')
  syncStatusVisibility()

  return false
}

export function showNoErrors () {
  errorDiv.classList.add('success')
  errorDiv.dataset.statusSource = 'script'
  errorDiv.innerText = 'No errors'
  syncStatusVisibility()
}

export function handleScriptError (stack) {
  handleError(stack)
  errorDiv.dataset.statusSource = 'script'
  syncStatusVisibility()
}

export function clearScriptStatus () {
  if (errorDiv.dataset.statusSource !== 'script') return

  errorDiv.classList.remove('success')
  delete errorDiv.dataset.statusSource
  errorDiv.innerText = ''
  syncStatusVisibility()
}

window.onerror = function (msg, url, lineNo, columnNo, err) {
  handleError(msg + '\n' + '   at ' + url + ':' + lineNo + ':' + columnNo)
}
