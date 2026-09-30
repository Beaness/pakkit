import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyMinecraftDataOverlay } from '../src/minecraftDataOverlay.mjs'

async function writeJson (file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value))
}

async function createFakePackage (root, knownVersions) {
  const dataDirectory = path.join(root, 'minecraft-data', 'data')
  const dataPaths = { pc: {} }
  for (const version of knownVersions) {
    dataPaths.pc[version] = { blocks: `pc/${version}`, protocol: `pc/${version}`, loginPacket: `pc/${version}` }
  }
  await writeJson(path.join(dataDirectory, 'dataPaths.json'), dataPaths)
  await writeJson(path.join(dataDirectory, 'pc', 'common', 'versions.json'), knownVersions)
  await fs.mkdir(path.join(root, 'bin'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'bin', 'generate_data.js'),
    "require('fs').writeFileSync(__dirname + '/../generated.marker', 'ok')\n"
  )
  return dataDirectory
}

async function createOverlay (root, version) {
  await writeJson(path.join(root, 'pc', version, 'protocol.json'), { marker: version })
  await writeJson(path.join(root, 'pc', version, 'version.json'), { minecraftVersion: version })
}

test('overlay adds versions the package does not know about', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pakkit-overlay-test-'))
  try {
    const packageDirectory = path.join(root, 'package')
    const overlayDirectory = path.join(root, 'overlay')
    const dataDirectory = await createFakePackage(packageDirectory, ['1.21.11', '26.1'])
    await createOverlay(overlayDirectory, '26.2')

    assert.deepEqual(await applyMinecraftDataOverlay(packageDirectory, overlayDirectory), ['26.2'])

    const dataPaths = JSON.parse(await fs.readFile(path.join(dataDirectory, 'dataPaths.json'), 'utf8'))
    assert.equal(dataPaths.pc['26.2'].protocol, 'pc/26.2')
    assert.equal(dataPaths.pc['26.2'].blocks, 'pc/26.1', 'files not in the overlay reuse the newest known version')
    const versions = JSON.parse(await fs.readFile(path.join(dataDirectory, 'pc', 'common', 'versions.json'), 'utf8'))
    assert.deepEqual(versions, ['1.21.11', '26.1', '26.2'])
    await fs.access(path.join(dataDirectory, 'pc', '26.2', 'protocol.json'))
    await fs.access(path.join(packageDirectory, 'generated.marker'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('overlay leaves versions the package already ships untouched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pakkit-overlay-test-'))
  try {
    const packageDirectory = path.join(root, 'package')
    const overlayDirectory = path.join(root, 'overlay')
    await createFakePackage(packageDirectory, ['26.1', '26.2'])
    await createOverlay(overlayDirectory, '26.2')

    assert.deepEqual(await applyMinecraftDataOverlay(packageDirectory, overlayDirectory), [])
    await assert.rejects(fs.access(path.join(packageDirectory, 'generated.marker')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
