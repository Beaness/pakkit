import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { x as extractTar } from 'tar'
import { applyMinecraftDataOverlay } from './minecraftDataOverlay.mjs'

const REGISTRY_URL = 'https://registry.npmjs.org/minecraft-data/latest'
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 10_000

function isSafeVersion (version) {
  return typeof version === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)
}

async function packageAt (packageDirectory, expectedVersion) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
    if (manifest.name !== 'minecraft-data' || manifest.version !== expectedVersion) return undefined

    const entryPath = path.join(packageDirectory, 'index.js')
    await fs.access(entryPath)
    return { version: expectedVersion, packageDirectory, entryPath }
  } catch {
    return undefined
  }
}

async function findCachedPackage (cacheDirectory) {
  const packagesDirectory = path.join(cacheDirectory, 'packages')
  const markerPath = path.join(cacheDirectory, 'current.json')

  try {
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    if (isSafeVersion(marker.version)) {
      const markedPackage = await packageAt(path.join(packagesDirectory, marker.version), marker.version)
      if (markedPackage) return markedPackage
    }
  } catch {
    // A missing or interrupted marker write is recoverable from the packages below.
  }

  let entries
  try {
    entries = await fs.readdir(packagesDirectory, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeVersion(entry.name)) continue
    const packageDirectory = path.join(packagesDirectory, entry.name)
    const cachedPackage = await packageAt(packageDirectory, entry.name)
    if (!cachedPackage) continue
    const stats = await fs.stat(packageDirectory)
    candidates.push({ ...cachedPackage, modifiedAt: stats.mtimeMs })
  }

  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return candidates[0]
}

async function writeCurrentMarker (cacheDirectory, version) {
  await fs.writeFile(
    path.join(cacheDirectory, 'current.json'),
    JSON.stringify({ version }, null, 2),
    'utf8'
  )
}

async function fetchWithTimeout (fetchImpl, url, options, handleResponse) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal })
    return await handleResponse(response)
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchLatestMetadata (fetchImpl) {
  return await fetchWithTimeout(fetchImpl, REGISTRY_URL, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache'
    }
  }, async response => {
    if (!response.ok) throw new Error(`The npm registry returned HTTP ${response.status}`)

    const metadata = await response.json()
    const tarballUrl = metadata?.dist?.tarball
    if (!isSafeVersion(metadata?.version) || typeof tarballUrl !== 'string') {
      throw new Error('The npm registry returned invalid minecraft-data metadata')
    }

    const parsedTarballUrl = new URL(tarballUrl)
    if (parsedTarballUrl.protocol !== 'https:') {
      throw new Error('The minecraft-data download URL was not secure')
    }

    return {
      version: metadata.version,
      tarballUrl,
      integrity: metadata.dist.integrity,
      shasum: metadata.dist.shasum
    }
  })
}

async function readLimitedBody (response) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PACKAGE_BYTES) {
    throw new Error('The minecraft-data download was unexpectedly large')
  }

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_PACKAGE_BYTES) throw new Error('The minecraft-data download was unexpectedly large')
    return buffer
  }

  const reader = response.body.getReader()
  const chunks = []
  let size = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_PACKAGE_BYTES) {
      await reader.cancel()
      throw new Error('The minecraft-data download was unexpectedly large')
    }
    chunks.push(Buffer.from(value))
  }

  return Buffer.concat(chunks, size)
}

function verifyPackageIntegrity (archive, metadata) {
  let algorithm
  let expectedDigest

  if (typeof metadata.integrity === 'string') {
    const integrity = metadata.integrity.split(/\s+/).find(value => value.startsWith('sha512-'))
    if (integrity) {
      algorithm = 'sha512'
      expectedDigest = Buffer.from(integrity.slice('sha512-'.length), 'base64')
    }
  }

  if (!expectedDigest && typeof metadata.shasum === 'string' && /^[a-f0-9]{40}$/i.test(metadata.shasum)) {
    algorithm = 'sha1'
    expectedDigest = Buffer.from(metadata.shasum, 'hex')
  }

  if (!expectedDigest) throw new Error('The npm registry did not provide a usable package checksum')

  const actualDigest = createHash(algorithm).update(archive).digest()
  if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    throw new Error('The minecraft-data download failed its checksum verification')
  }
}

async function installPackage (cacheDirectory, metadata, fetchImpl, onStatus) {
  const packagesDirectory = path.join(cacheDirectory, 'packages')
  const destination = path.join(packagesDirectory, metadata.version)
  const alreadyInstalled = await packageAt(destination, metadata.version)
  if (alreadyInstalled) return alreadyInstalled

  onStatus?.({ stage: 'downloading', message: `Downloading minecraft-data ${metadata.version}…` })
  const archive = await fetchWithTimeout(fetchImpl, metadata.tarballUrl, {}, async response => {
    if (!response.ok) throw new Error(`The package download returned HTTP ${response.status}`)
    return await readLimitedBody(response)
  })
  verifyPackageIntegrity(archive, metadata)

  onStatus?.({ stage: 'installing', message: `Installing minecraft-data ${metadata.version}…` })
  await fs.mkdir(packagesDirectory, { recursive: true })
  await fs.rm(destination, { recursive: true, force: true })
  const temporaryDirectory = await fs.mkdtemp(path.join(cacheDirectory, '.install-'))
  const extractionDirectory = path.join(temporaryDirectory, 'package')
  const archivePath = path.join(temporaryDirectory, 'minecraft-data.tgz')

  try {
    await fs.mkdir(extractionDirectory)
    await fs.writeFile(archivePath, archive)
    await extractTar({
      cwd: extractionDirectory,
      file: archivePath,
      preservePaths: false,
      strict: true,
      strip: 1
    })

    const extractedPackage = await packageAt(extractionDirectory, metadata.version)
    if (!extractedPackage) throw new Error('The downloaded minecraft-data package was invalid')

    try {
      await fs.rename(extractionDirectory, destination)
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }

  const installedPackage = await packageAt(destination, metadata.version)
  if (!installedPackage) throw new Error('minecraft-data could not be installed in the local cache')
  return installedPackage
}

async function resolveLatestMinecraftData ({
  cacheDirectory,
  fetchImpl,
  onStatus
}) {
  if (typeof fetchImpl !== 'function') throw new Error('This runtime does not provide the Fetch API')

  await fs.mkdir(cacheDirectory, { recursive: true })
  const cachedPackage = await findCachedPackage(cacheDirectory)
  onStatus?.({ stage: 'checking', message: 'Checking for minecraft-data updates…' })

  let metadata
  try {
    metadata = await fetchLatestMetadata(fetchImpl)
  } catch (error) {
    if (!cachedPackage) throw error
    await writeCurrentMarker(cacheDirectory, cachedPackage.version)
    return { ...cachedPackage, updated: false, warning: error }
  }

  if (cachedPackage?.version === metadata.version) {
    await writeCurrentMarker(cacheDirectory, cachedPackage.version)
    return { ...cachedPackage, updated: false }
  }

  let installedPackage
  try {
    installedPackage = await installPackage(cacheDirectory, metadata, fetchImpl, onStatus)
  } catch (error) {
    if (!cachedPackage) throw error
    await writeCurrentMarker(cacheDirectory, cachedPackage.version)
    return { ...cachedPackage, updated: false, warning: error }
  }

  await writeCurrentMarker(cacheDirectory, installedPackage.version)
  return { ...installedPackage, updated: true }
}

export async function ensureLatestMinecraftData ({
  cacheDirectory,
  fetchImpl = globalThis.fetch,
  overlayDirectory,
  onStatus
}) {
  const resolvedPackage = await resolveLatestMinecraftData({ cacheDirectory, fetchImpl, onStatus })
  if (overlayDirectory) {
    // Also covers cached packages that were installed before the overlay existed.
    await applyMinecraftDataOverlay(resolvedPackage.packageDirectory, overlayDirectory)
  }
  return resolvedPackage
}
