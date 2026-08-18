import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { c as createTar } from 'tar'

import { ensureLatestMinecraftData } from '../src/minecraftDataUpdater.mjs'

async function makeTemporaryDirectory () {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pakkit-minecraft-data-test-'))
}

async function createCachedPackage (cacheDirectory, version) {
  const packageDirectory = path.join(cacheDirectory, 'packages', version)
  await fs.mkdir(packageDirectory, { recursive: true })
  await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'minecraft-data',
    version
  }))
  await fs.writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = {}\n')
  await fs.writeFile(path.join(cacheDirectory, 'current.json'), JSON.stringify({ version }))
  return packageDirectory
}

function metadataResponse (version, integrity = 'sha512-unused') {
  return {
    ok: true,
    json: async () => ({
      name: 'minecraft-data',
      version,
      dist: {
        tarball: `https://registry.npmjs.org/minecraft-data/-/minecraft-data-${version}.tgz`,
        integrity
      }
    })
  }
}

test('a cached minecraft-data version is reused when it is still latest', async () => {
  const cacheDirectory = await makeTemporaryDirectory()
  try {
    await createCachedPackage(cacheDirectory, '3.1.0')
    let fetchCount = 0
    const result = await ensureLatestMinecraftData({
      cacheDirectory,
      fetchImpl: async () => {
        fetchCount++
        return metadataResponse('3.1.0')
      }
    })

    assert.equal(result.version, '3.1.0')
    assert.equal(result.updated, false)
    assert.equal(fetchCount, 1)
  } finally {
    await fs.rm(cacheDirectory, { recursive: true, force: true })
  }
})

test('the updater downloads, verifies, and extracts a newer package', async () => {
  const rootDirectory = await makeTemporaryDirectory()
  const cacheDirectory = path.join(rootDirectory, 'cache')
  const fixtureDirectory = path.join(rootDirectory, 'fixture')
  const packageDirectory = path.join(fixtureDirectory, 'package')
  const archivePath = path.join(rootDirectory, 'minecraft-data.tgz')

  try {
    await fs.mkdir(packageDirectory, { recursive: true })
    await fs.writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'minecraft-data',
      version: '3.2.0'
    }))
    await fs.writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = {}\n')
    await createTar({ cwd: fixtureDirectory, file: archivePath, gzip: true }, ['package'])
    const archive = await fs.readFile(archivePath)
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    const stages = []

    const result = await ensureLatestMinecraftData({
      cacheDirectory,
      fetchImpl: async url => {
        if (url.endsWith('/latest')) return metadataResponse('3.2.0', integrity)
        return {
          ok: true,
          headers: { get: () => String(archive.length) },
          arrayBuffer: async () => archive
        }
      },
      onStatus: status => stages.push(status.stage)
    })

    assert.equal(result.version, '3.2.0')
    assert.equal(result.updated, true)
    assert.equal(JSON.parse(await fs.readFile(path.join(cacheDirectory, 'current.json'))).version, '3.2.0')
    assert.deepEqual(stages, ['checking', 'downloading', 'installing'])
  } finally {
    await fs.rm(rootDirectory, { recursive: true, force: true })
  }
})

test('a cached package remains usable when the registry is offline', async () => {
  const cacheDirectory = await makeTemporaryDirectory()
  try {
    await createCachedPackage(cacheDirectory, '3.1.0')
    const networkError = new Error('offline')
    const result = await ensureLatestMinecraftData({
      cacheDirectory,
      fetchImpl: async () => { throw networkError }
    })

    assert.equal(result.version, '3.1.0')
    assert.equal(result.updated, false)
    assert.equal(result.warning, networkError)
  } finally {
    await fs.rm(cacheDirectory, { recursive: true, force: true })
  }
})
