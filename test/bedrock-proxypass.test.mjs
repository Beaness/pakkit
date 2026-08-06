import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import dgram from 'node:dgram'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import AdmZip from 'adm-zip'
import WebSocket from 'ws'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const proxyPassJar = path.join(projectRoot, 'data', 'proxypass-pakkit.jar')

function hasJava () {
  return !spawnSync('java', ['-version'], { stdio: 'ignore' }).error
}

function freeTcpPort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function freeUdpPort () {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      const port = socket.address().port
      socket.close(() => resolve(port))
    })
  })
}

test('bundled ProxyPass targets the latest Bedrock protocol', t => {
  if (!hasJava()) return t.skip('Java is not installed')

  const result = spawnSync('java', ['-jar', proxyPassJar, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)

  const version = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
  assert.deepEqual(version, {
    minecraftVersion: '1.26.40',
    protocolVersion: 2168,
    protocolLibraryVersion: '3.0.0.Beta13-20260805.201455-7',
    proxyPassCommit: '35d6c6af4d5030b58dd6f5168fc3c9a02a481062',
    pakkitBridgeVersion: 2,
    raknetPacketLimit: 'disabled'
  })

  const manifest = new AdmZip(proxyPassJar).readAsText('META-INF/MANIFEST.MF')
  assert.match(manifest, /Main-Class: org\.cloudburstmc\.proxypass\.ProxyPass/)
  assert.match(manifest, /Bedrock-Protocol-Version: 2168/)
  assert.match(manifest, /Pakkit-Bridge-Version: 2/)
  assert.match(manifest, /RakNet-Packet-Limit: disabled/)
})

test('ProxyPass exposes its authenticated pakkit bridge and packet mappings', async t => {
  if (!hasJava()) return t.skip('Java is not installed')

  const [proxyPort, websocketPort] = await Promise.all([freeUdpPort(), freeTcpPort()])
  const token = 'pakkit-test-token'
  const child = spawn('java', [
    '-jar', proxyPassJar, '--start-from-args',
    '127.0.0.1', String(proxyPort), '127.0.0.1', '19132',
    '1', 'true', 'true', 'pakkit', 'pakkit-test', 'true', String(websocketPort), token
  ], { cwd: projectRoot, windowsHide: true })

  let processOutput = ''
  child.stdout.on('data', chunk => { processOutput += chunk })
  child.stderr.on('data', chunk => { processOutput += chunk })
  t.after(() => {
    if (!child.killed) child.kill()
  })

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`ProxyPass startup timed out:\n${processOutput}`)), 15_000)
    const check = () => {
      if (processOutput.includes('Websocket started')) {
        clearTimeout(timeout)
        resolve()
      } else if (child.exitCode !== null) {
        clearTimeout(timeout)
        reject(new Error(`ProxyPass exited during startup:\n${processOutput}`))
      } else {
        setTimeout(check, 50)
      }
    }
    check()
  })

  const messages = await new Promise((resolve, reject) => {
    let attempts = 0
    const connect = () => {
      attempts++
      const socket = new WebSocket(`ws://127.0.0.1:${websocketPort}/${token}`)
      const received = []
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error(`ProxyPass bridge timed out:\n${processOutput}`))
      }, 10_000)

      socket.on('message', raw => {
        received.push(JSON.parse(raw.toString()))
        if (received.some(message => message.eventType === 'proxyInfo') &&
            received.some(message => message.eventType === 'filteringPackets')) {
          clearTimeout(timeout)
          socket.close()
          resolve(received)
        }
      })
      socket.once('error', error => {
        clearTimeout(timeout)
        socket.close()
        if (attempts < 10) setTimeout(connect, 100)
        else reject(error)
      })
    }
    connect()
  })

  const proxyInfo = JSON.parse(messages.find(message => message.eventType === 'proxyInfo').eventData)
  const mappings = JSON.parse(messages.find(message => message.eventType === 'filteringPackets').eventData)
  assert.equal(proxyInfo.minecraftVersion, '1.26.40')
  assert.equal(proxyInfo.protocolVersion, 2168)
  assert.equal(proxyInfo.raknetPacketLimit, 'disabled')
  assert.ok(Object.keys(mappings).length > 200)
  assert.equal(mappings['1'], 'LOGIN')
})
