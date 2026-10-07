import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const packageRequire = createRequire(import.meta.url)

async function readJson (file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeJson (file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

async function listOverlayVersions (overlayDirectory) {
  try {
    const entries = await fs.readdir(path.join(overlayDirectory, 'pc'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

// Adds Minecraft versions that the downloaded minecraft-data release does not
// know about yet (for example 26.2 and 26.3, which are still unreleased
// upstream). Versions the package already ships are left untouched, so this
// becomes a no-op as soon as minecraft-data publishes them.
export async function applyMinecraftDataOverlay (packageDirectory, overlayDirectory) {
  const pending = await listOverlayVersions(overlayDirectory)
  if (pending.length === 0) return []

  const dataDirectory = path.join(packageDirectory, 'minecraft-data', 'data')
  const dataPathsFile = path.join(dataDirectory, 'dataPaths.json')
  const versionsFile = path.join(dataDirectory, 'pc', 'common', 'versions.json')
  const dataPaths = await readJson(dataPathsFile)
  const versions = await readJson(versionsFile)

  const missing = pending.filter(version => !dataPaths.pc[version])
  if (missing.length === 0) return []

  for (const version of missing) {
    // A new version reuses the newest known version's registries and
    // overrides only the files the overlay actually provides.
    const knownVersions = Object.keys(dataPaths.pc)
    const entry = { ...dataPaths.pc[knownVersions[knownVersions.length - 1]] }

    const sourceDirectory = path.join(overlayDirectory, 'pc', version)
    const targetDirectory = path.join(dataDirectory, 'pc', version)
    await fs.mkdir(targetDirectory, { recursive: true })
    for (const file of await fs.readdir(sourceDirectory)) {
      if (!file.endsWith('.json')) continue
      await fs.copyFile(path.join(sourceDirectory, file), path.join(targetDirectory, file))
      entry[path.basename(file, '.json')] = `pc/${version}`
    }

    dataPaths.pc[version] = entry
    if (!versions.includes(version)) versions.push(version)
  }

  await writeJson(dataPathsFile, dataPaths)
  await writeJson(versionsFile, versions)

  // data.js is generated from dataPaths.json when minecraft-data is published.
  packageRequire(path.join(packageDirectory, 'bin', 'generate_data.js'))
  return missing
}
