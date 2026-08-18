import Module, { createRequire } from 'node:module'

const runtimeRequire = createRequire(import.meta.url)
const originalModuleLoad = Module._load
let activeMinecraftData
let overrideInstalled = false

function installMinecraftDataOverride () {
  if (overrideInstalled) return

  // minecraft-protocol requires minecraft-data from several internal CommonJS
  // modules. Redirect those requests to the user-data copy without modifying
  // the read-only packaged application directory.
  Module._load = function (request, parent, isMain) {
    if (request === 'minecraft-data' && activeMinecraftData) return activeMinecraftData
    return originalModuleLoad.call(this, request, parent, isMain)
  }
  overrideInstalled = true
}

export function loadMinecraftRuntime (minecraftDataEntryPath) {
  activeMinecraftData = runtimeRequire(minecraftDataEntryPath)
  installMinecraftDataOverride()

  return {
    minecraftData: activeMinecraftData,
    minecraftProtocol: runtimeRequire('minecraft-protocol')
  }
}
