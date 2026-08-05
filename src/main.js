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
import * as bedrockProxy from './proxy/bedrock/proxy.js'
import * as packetHandler from './packetHandler.js'
import * as setupDataFolder from './setupDataFolder.js'
import { resolveServerAddress } from './resolveAddress.js'
import { ApolloDecoder } from './apolloDecoder.js'

program
  .option('-a, --autostart', 'Automatically starts the program without the start window (all below options must be set)')
  .option('-e, --platform <platform>', 'Platform (accepted values: java, bedrock)')
  .option('-v, --version <version>', 'The version to use, or auto to detect it from the Java client (not needed for Bedrock)')
  .option('-c, --connect <address>', 'The address of the server to connect to (e.g. localhost, mc.hypixel.net, localhost:25570)')
  .option('-P, --listen-port  <port>', 'The port to listen on')

program.parse(process.argv)
const options = program.opts()

if (options.autostart) {
  if (!options.platform || !(options.version || options.platform !== 'java') || !options.connect || !options.listenPort) {
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
// two levels up. When packaged with extraResource, assets live in resources/.
const projectRoot = path.resolve(__dirname, '..', '..')
const isDev = !app.isPackaged
const iconsDir = isDev ? path.join(projectRoot, 'icons') : path.join(process.resourcesPath, 'icons')
const sourceDataJar = isDev
  ? path.join(projectRoot, 'data', 'proxypass-pakkit.jar')
  : path.join(process.resourcesPath, 'data', 'proxypass-pakkit.jar')

const osDataFolder = app.getPath('appData')
const dataFolder = setupDataFolder.setup(osDataFolder, sourceDataJar)
const apolloDecoder = new ApolloDecoder(dataFolder)

let currentScriptFile = null

function loadRendererPage (win, page) {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/${page}`)
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/${page}`))
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
  // and load the index.html of the app.
  if (options.autostart) {
    startProxy({
      // TODO: make online-mode working in headless via command-line parameters
      consent: false,
      onlineMode: false,
      connectAddress: options.connect,
      listenPort: options.listenPort,
      platform: options.platform,
      version: options.version
    })
  } else {
    loadRendererPage(win, 'startPage.html')
  }
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

function showAuthCode (data) {
  const win = BrowserWindow.getAllWindows()[0]
  win.send('showAuthCode', JSON.stringify(data))
}

async function startProxy (args) {
  if (args.platform === 'java') {
    proxy = javaProxy
  } else {
    proxy = bedrockProxy
  }

  const win = BrowserWindow.getAllWindows()[0]

  // Resolve the server address the same way the Minecraft client does:
  // parse host:port, then SRV lookup for _minecraft._tcp.<host> when no
  // custom port was given.
  const { host, port } = await resolveServerAddress(args.connectAddress, args.platform)
  console.log(`Resolved ${args.connectAddress} -> ${host}:${port}`)

  packetHandler.init(BrowserWindow.getAllWindows()[0], ipcMain, proxy)
  proxy.startProxy(host, port, args.listenPort, args.version, args.onlineMode,
    args.consent, packetHandler.packetHandler, packetHandler.messageHandler, dataFolder, () => {
      win.send('updateFiltering', '')
    }, showAuthCode)

  loadRendererPage(win, 'mainPage.html')

  // Load the previous state with fallback to defaults
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1000,
    defaultHeight: 800
  })

  win.setResizable(true)
  // electron-window-state doesn't provide x/y defaults on first run
  // (only width/height), so guard against undefined for Electron 42+
  win.setPosition(mainWindowState.x ?? 0, mainWindowState.y ?? 0)
  win.setSize(mainWindowState.width ?? 1000, mainWindowState.height ?? 800)

  mainWindowState.manage(win)
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
