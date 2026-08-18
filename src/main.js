import path from 'node:path'
import fs from 'node:fs'
import { program } from 'commander'
import { app, BrowserWindow, ipcMain, clipboard, Menu, dialog, shell } from 'electron'
import Store from 'electron-store'
import electronLocalShortcut from 'electron-localshortcut'
import windowStateKeeper from 'electron-window-state'
import unhandled from 'electron-unhandled'
import squirrelStartup from 'electron-squirrel-startup'

import * as javaProxy from './proxy/java/proxy.js'
import * as packetHandler from './packetHandler.js'
import { resolveServerAddress } from './resolveAddress.js'
import { ApolloDecoder } from './apolloDecoder.js'
import { loadMinecraftRuntime } from './minecraftDataRuntime.mjs'
import { ensureLatestMinecraftData } from './minecraftDataUpdater.mjs'
import { stopSessionAndLoadStart } from './sessionLifecycle.mjs'

program
  .option('-a, --autostart', 'Automatically starts the program without the start window (all below options must be set)')
  .option('-v, --version <version>', 'The version to use, or auto to detect it from the Java client')
  .option('-c, --connect <address>', 'The address of the server to connect to (e.g. localhost, mc.hypixel.net, localhost:25570)')
  .option('-P, --listen-port  <port>', 'The port to listen on')

program.parse(process.argv)
const options = program.opts()

if (options.autostart) {
  if (!options.version || !options.connect || !options.listenPort) {
    console.log('Not all required options were passed.')
    program.help()
  }
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (squirrelStartup) {
  app.quit()
}

const store = new Store()

let proxy // Defined later when an option is chosen

// In development the main bundle lives in `.vite/build`, so the project root is
// two levels up. When packaged with extraResource, icons live in resources/.
const projectRoot = path.resolve(__dirname, '..', '..')
const isDev = !app.isPackaged
const iconsDir = isDev ? path.join(projectRoot, 'icons') : path.join(process.resourcesPath, 'icons')
const dataFolder = path.join(app.getPath('appData'), 'pakkit')
fs.mkdirSync(dataFolder, { recursive: true })
const apolloDecoder = new ApolloDecoder(dataFolder)
const minecraftDataCache = path.join(dataFolder, 'minecraft-data')

let currentScriptFile = null
let returningToStart = false
let mainWindowState
let minecraftData
let minecraftDataBootPromise

function loadRendererPage (win, page) {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/${page}`)
  } else {
    return win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/${page}`))
  }
}

function sendMinecraftDataStatus (win, status) {
  if (!win.isDestroyed()) win.send('minecraft-data-status', JSON.stringify(status))
}

async function prepareMinecraftData (win) {
  if (minecraftData) return
  if (minecraftDataBootPromise) return await minecraftDataBootPromise

  minecraftDataBootPromise = (async () => {
    const installedPackage = await ensureLatestMinecraftData({
      cacheDirectory: minecraftDataCache,
      onStatus: status => sendMinecraftDataStatus(win, status)
    })

    if (installedPackage.warning) {
      console.warn(
        `Unable to update minecraft-data; using cached ${installedPackage.version}:`,
        installedPackage.warning
      )
    }

    const runtime = loadMinecraftRuntime(installedPackage.entryPath)
    minecraftData = runtime.minecraftData
    javaProxy.initializeDependencies(runtime)
    sendMinecraftDataStatus(win, {
      stage: 'ready',
      message: `minecraft-data ${installedPackage.version} is ready`
    })
  })()

  try {
    await minecraftDataBootPromise
  } catch (error) {
    minecraftDataBootPromise = undefined
    throw error
  }
}

async function loadInitialPage (win) {
  if (options.autostart) {
    await startProxy({
      // TODO: make online-mode working in headless via command-line parameters
      consent: false,
      onlineMode: false,
      connectAddress: options.connect,
      listenPort: options.listenPort,
      version: options.version
    })
  } else {
    await loadRendererPage(win, 'startPage.html')
  }
}

async function bootstrapWindow (win) {
  await loadRendererPage(win, 'loadingPage.html')

  try {
    await prepareMinecraftData(win)
    await loadInitialPage(win)
  } catch (error) {
    console.error('Unable to prepare minecraft-data:', error)
    if (!win.isDestroyed()) {
      win.send('minecraft-data-update-error', JSON.stringify({
        message: `Could not download minecraft-data. Check your connection and retry. (${error.message})`
      }))
    }
  }
}

async function returnToStart () {
  if (returningToStart) return

  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return

  returningToStart = true
  const activeProxy = proxy
  proxy = undefined

  try {
    const stopError = await stopSessionAndLoadStart({
      activeProxy,
      disposePacketHandlers: packetHandler.dispose,
      loadStartPage: () => loadRendererPage(win, 'startPage.html')
    })
    if (stopError) console.error('Failed to stop proxy cleanly:', stopError)
  } finally {
    returningToStart = false
  }
}

function makeMenu (direction, text, id, invalid, noData, apollo) {
  if (direction !== 'clientbound' && direction !== 'serverbound') {
    // This probably isn't a packet
    return
  }

  const menuData = [
    {
      icon: path.join(iconsDir, `${direction + (invalid ? '-invalid' : '')}.png`),
      label: text,
      enabled: false
    },
    {
      type: 'separator'
    },
    {
      label: 'Edit and resend',
      enabled: !noData,
      click: () => {
        BrowserWindow.getAllWindows()[0].send('editAndResend', JSON.stringify({
          id: id
        }))
      },
      visible: proxy.capabilities.modifyPackets
    },
    {
      label: 'Hide all packets of this type',
      click: () => {
        BrowserWindow.getAllWindows()[0].send('hideAllOfType', JSON.stringify({
          // Packet ID from link URL
          id: id
        }))
      }
    }
  ]

  if (!noData) {
    menuData.splice(2, 0,
      {
        label: proxy.capabilities.jsonData ? 'Copy JSON data' : 'Copy data',
        click: () => {
          BrowserWindow.getAllWindows()[0].send('copyPacketData', JSON.stringify({
            id: id
          }))
        }
      }
    )
  }

  if (!noData && text.split(' ')[1] === 'position' && direction === 'clientbound') {
    menuData.splice(3, 0,
      {
        label: 'Copy teleport as command',
        click: () => {
          BrowserWindow.getAllWindows()[0].send('copyTeleportCommand', JSON.stringify({
            id: id
          }))
        }
      }
    )
  }

  if (proxy.capabilities.rawData) {
    menuData.splice(3, 0,
      {
        label: 'Copy hex data',
        click: () => {
          BrowserWindow.getAllWindows()[0].send('copyHexData', JSON.stringify({
            id: id
          }))
        }
      }
    )
  }

  if (apollo) {
    menuData.splice(3, 0,
      {
        label: 'Copy Apollo data',
        click: () => {
          BrowserWindow.getAllWindows()[0].send('copyApolloData', JSON.stringify({
            id: id
          }))
        }
      }
    )
  }

  return Menu.buildFromTemplate(menuData)
}

function createWindow () {
  // Create the browser window.
  const win = new BrowserWindow({
    height: 720,
    width: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(iconsDir, 'icon.png')
  })

  win.setMenuBarVisibility(false)

  // Open the DevTools.
  // win.webContents.openDevTools()
  electronLocalShortcut.register(win, 'F12', () => {
    win.openDevTools()
  })

  win.webContents.setWindowOpenHandler(function (details) {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  unhandled({
    logger: (err) => {
      win.send('error', JSON.stringify({ msg: err.message, stack: err.stack }))
      console.log(err.stack)
      console.error(err)
    },
    showDialog: false
  })

  win.setMenu(null)
  bootstrapWindow(win).catch(error => console.error('Unable to bootstrap pakkit:', error))
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(createWindow)

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    if (proxy) {
      proxy.end()
    }
    app.quit()
  }
})

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

ipcMain.on('startProxy', (event, arg) => {
  const ipcMessage = JSON.parse(arg)
  startProxy(ipcMessage)
})

ipcMain.on('minecraft-data-versions', event => {
  const versions = minecraftData?.supportedVersions?.pc || []
  event.returnValue = JSON.stringify([...versions].reverse())
})

ipcMain.on('retryMinecraftDataUpdate', event => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) bootstrapWindow(win).catch(error => console.error('Unable to retry minecraft-data update:', error))
})

ipcMain.on('quitApp', () => app.quit())

function showAuthCode (data) {
  const win = BrowserWindow.getAllWindows()[0]
  win.send('showAuthCode', JSON.stringify(data))
}

async function startProxy (args) {
  proxy = javaProxy

  const win = BrowserWindow.getAllWindows()[0]

  // Resolve the server address the same way the Minecraft client does:
  // parse host:port, then SRV lookup for _minecraft._tcp.<host> when no
  // custom port was given.
  const { host, port } = await resolveServerAddress(args.connectAddress)
  console.log(`Resolved ${args.connectAddress} -> ${host}:${port}`)

  packetHandler.init(BrowserWindow.getAllWindows()[0], ipcMain, proxy)
  proxy.startProxy(host, port, args.listenPort, args.version, args.onlineMode,
    args.consent, packetHandler.packetHandler, packetHandler.messageHandler, dataFolder, () => {
      win.send('updateFiltering', '')
    }, showAuthCode)

  loadRendererPage(win, 'mainPage.html')

  // Load the previous state with fallback to defaults
  if (!mainWindowState) {
    mainWindowState = windowStateKeeper({
      defaultWidth: 1000,
      defaultHeight: 800
    })
    mainWindowState.manage(win)
  }

  win.setResizable(true)
  // electron-window-state doesn't provide x/y defaults on first run
  // (only width/height), so guard against undefined for Electron 42+
  win.setPosition(mainWindowState.x ?? 0, mainWindowState.y ?? 0)
  win.setSize(mainWindowState.width ?? 1000, mainWindowState.height ?? 800)

}

ipcMain.on('proxyCapabilities', (event, arg) => {
  event.returnValue = JSON.stringify(proxy.capabilities)
})

ipcMain.on('copyToClipboard', (event, arg) => {
  clipboard.writeText(arg)
})

ipcMain.handle('decodeApolloPayload', async (event, arg) => {
  const { payload } = JSON.parse(arg)
  return await apolloDecoder.decode(payload)
})

ipcMain.on('contextMenu', (event, arg) => {
  const ipcMessage = JSON.parse(arg)
  makeMenu(ipcMessage.direction, ipcMessage.text, ipcMessage.id, ipcMessage.invalid, ipcMessage.noData, ipcMessage.apollo).popup(BrowserWindow.getAllWindows()[0])
})

ipcMain.on('relaunchApp', (event, arg) => {
  app.relaunch()
  app.exit()
})

ipcMain.on('returnToStart', () => {
  returnToStart().catch(error => console.error('Unable to return to connection setup:', error))
})

// Store proxy: the renderer reads/writes persistent settings via IPC so that
// electron-store (ESM) only needs to run in the main process.
ipcMain.on('store-get', (event, key) => {
  event.returnValue = store.get(key)
})

ipcMain.on('store-set', (event, arg) => {
  const { key, value } = JSON.parse(arg)
  store.set(key, value)
  event.returnValue = true
})

ipcMain.on('store-has', (event, key) => {
  event.returnValue = store.has(key)
})

ipcMain.on('saveLog', async (event, arg) => {
  const win = BrowserWindow.getAllWindows()[0]

  const result = await dialog.showSaveDialog(win, {
    filters: [
      { name: 'pakkit log files', extensions: ['pakkit-json'] }
      // { name: 'All Files', extensions: ['*'] }
    ]
  })

  if (!result.canceled) {
    const realPath = result.filePath.endsWith('.pakkit-json') ? result.filePath : result.filePath + '.pakkit-json'
    console.log('Saving log to', realPath)
    fs.writeFile(realPath, arg, function (err) {
      if (err) throw err
      console.log('Saved!')
    })
  }
})

ipcMain.on('loadLog', async (event, arg) => {
  const win = BrowserWindow.getAllWindows()[0]

  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'pakkit log files', extensions: ['pakkit-json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })

  if (!result.canceled) {
    // It's an array, but we have multi-select off so it should only have one item
    console.log('Loading log from', result.filePaths[0])
    fs.readFile(result.filePaths[0], 'utf-8', function (err, data) {
      if (err) throw err
      console.log('File has been read')
      win.send('loadLogData', data)
    })
  }
})

ipcMain.on('saveAsScript', async (event, arg) => {
  const win = BrowserWindow.getAllWindows()[0]

  const result = await dialog.showSaveDialog(win, {
    title: 'Save user script',
    filters: [
      { name: 'javascript files', extensions: ['js'] }
    ]
  })

  if (!result.canceled) {
    const realPath = result.filePath.endsWith('.js') ? result.filePath : result.filePath + '.js'
    win.send('disableBtnScriptSave')
    console.log('Saving script to', realPath)
    fs.writeFile(realPath, arg, function (err) {
      if (err) throw err
      console.log('Saved!')
      currentScriptFile = realPath
      win.send('enableBtnScriptSave', currentScriptFile)
    })
  }
})

ipcMain.on('saveScript', async (event, arg) => {
  const win = BrowserWindow.getAllWindows()[0]
  const validScriptPath = (currentScriptFile != null || fs.existsSync(currentScriptFile))

  win.send('disableBtnScriptSave')

  if (validScriptPath) {
    console.log('Overwrite script to', currentScriptFile)
    fs.writeFile(currentScriptFile, arg, function (err) {
      if (err) throw err
      console.log('Saved!')
      win.send('enableBtnScriptSave', currentScriptFile)
    })
  }
})

ipcMain.on('loadScript', async (event, arg) => {
  const win = BrowserWindow.getAllWindows()[0]

  const result = await dialog.showOpenDialog(win, {
    title: 'Load user script',
    filters: [
      { name: 'javascript files', extensions: ['js'] }
    ],
    properties: ['openFile']
  })

  if (!result.canceled) {
    win.send('disableBtnScriptSave')

    // It's an array, but we have multi-select off so it should only have one item
    console.log('Loading script from', result.filePaths[0])
    fs.readFile(result.filePaths[0], 'utf-8', function (err, data) {
      if (err) throw err
      console.log('File has been read')
      currentScriptFile = result.filePaths[0]
      win.send('loadScriptData', data)
      win.send('enableBtnScriptSave', currentScriptFile)
    })
  }
})
