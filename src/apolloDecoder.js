import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import AdmZip from 'adm-zip'
import protobuf from 'protobufjs'

const APOLLO_SCHEMA_URL = 'https://buf.build/lunarclient/apollo/archive/main.zip?imports=true'
const MAX_SCHEMA_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_SCHEMA_EXTRACTED_BYTES = 50 * 1024 * 1024

const anyType = protobuf.parse(`
  syntax = "proto3";
  package google.protobuf;
  message Any {
    string type_url = 1;
    bytes value = 2;
  }
`).root.lookupType('google.protobuf.Any')

function sha256 (data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function collectProtoFiles (directory) {
  const files = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectProtoFiles(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.proto')) {
      files.push(entryPath)
    }
  }

  return files
}

async function loadSchema (schemaDirectory) {
  const files = collectProtoFiles(schemaDirectory)
  if (files.length === 0) throw new Error('The downloaded Apollo schema did not contain any .proto files')

  const root = new protobuf.Root()
  for (const file of files) {
    try {
      protobuf.parse(fs.readFileSync(file, 'utf8'), root)
    } catch (error) {
      throw new Error(`Could not parse ${path.relative(schemaDirectory, file)}: ${error.message}`)
    }
  }
  root.resolveAll()
  return root
}

function validateArchive (zip) {
  let extractedBytes = 0
  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName.replaceAll('\\', '/')
    if (entryName.startsWith('/') || entryName.split('/').includes('..')) {
      throw new Error(`The Apollo schema archive contained an unsafe path: ${entry.entryName}`)
    }
    extractedBytes += entry.header.size
  }

  if (extractedBytes > MAX_SCHEMA_EXTRACTED_BYTES) {
    throw new Error(`The extracted Apollo schema was unexpectedly large (${extractedBytes} bytes)`)
  }
}

function replaceDirectory (source, destination) {
  const backup = `${destination}.old`
  fs.rmSync(backup, { recursive: true, force: true })

  if (fs.existsSync(destination)) fs.renameSync(destination, backup)
  try {
    fs.renameSync(source, destination)
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination)
    throw error
  }
}

function writeArchive (archivePath, contents) {
  const temporaryArchivePath = `${archivePath}.tmp`
  fs.writeFileSync(temporaryArchivePath, contents)
  fs.rmSync(archivePath, { force: true })
  fs.renameSync(temporaryArchivePath, archivePath)
}

export function payloadToBuffer (payload) {
  if (Buffer.isBuffer(payload)) return payload
  if (Array.isArray(payload)) return Buffer.from(payload)
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload && Array.isArray(payload.data)) return Buffer.from(payload.data)
  throw new Error('The lunar:apollo packet did not contain a byte payload')
}

export function decodeAny (payload) {
  const envelope = anyType.decode(payloadToBuffer(payload))
  if (!envelope.typeUrl) throw new Error('The Apollo payload did not identify a protobuf message type')

  const typeName = envelope.typeUrl.slice(envelope.typeUrl.lastIndexOf('/') + 1).replace(/^\./, '')
  if (!typeName) throw new Error(`The Apollo payload used an invalid protobuf type URL: ${envelope.typeUrl}`)

  return {
    typeUrl: envelope.typeUrl,
    typeName,
    value: Buffer.from(envelope.value)
  }
}

export class ApolloDecoder {
  constructor (dataFolder, fetchImplementation = globalThis.fetch) {
    this.cacheDirectory = path.join(dataFolder, 'apollo')
    this.schemaDirectory = path.join(this.cacheDirectory, 'schema')
    this.archivePath = path.join(this.cacheDirectory, 'apollo-schema.zip')
    this.fetch = fetchImplementation
    this.schemaPromise = undefined
  }

  async getSchema () {
    if (!this.schemaPromise) {
      const pendingSchema = this.updateAndLoadSchema().catch((error) => {
        if (this.schemaPromise === pendingSchema) this.schemaPromise = undefined
        throw error
      })
      this.schemaPromise = pendingSchema
    }
    return this.schemaPromise
  }

  async updateAndLoadSchema () {
    fs.mkdirSync(this.cacheDirectory, { recursive: true })

    try {
      const response = await this.fetch(APOLLO_SCHEMA_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Buf returned HTTP ${response.status}`)

      const archive = Buffer.from(await response.arrayBuffer())
      if (archive.length > MAX_SCHEMA_ARCHIVE_BYTES) {
        throw new Error(`The Apollo schema archive was unexpectedly large (${archive.length} bytes)`)
      }

      const cachedArchive = fs.existsSync(this.archivePath) ? fs.readFileSync(this.archivePath) : undefined
      if (cachedArchive && sha256(cachedArchive) === sha256(archive) && fs.existsSync(this.schemaDirectory)) {
        return await loadSchema(this.schemaDirectory)
      }

      const zip = new AdmZip(archive)
      validateArchive(zip)

      const temporarySchemaDirectory = path.join(this.cacheDirectory, `schema-${process.pid}-${Date.now()}.tmp`)
      fs.mkdirSync(temporarySchemaDirectory)
      try {
        zip.extractAllTo(temporarySchemaDirectory, true)
        const root = await loadSchema(temporarySchemaDirectory)
        replaceDirectory(temporarySchemaDirectory, this.schemaDirectory)
        writeArchive(this.archivePath, archive)
        return root
      } finally {
        fs.rmSync(temporarySchemaDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      if (fs.existsSync(this.schemaDirectory)) {
        console.warn(`Could not update the Apollo protobuf schema; using the cached copy: ${error.message}`)
        return await loadSchema(this.schemaDirectory)
      }

      throw new Error(`Could not download the Apollo protobuf schema and no cached copy is available: ${error.message}`)
    }
  }

  async decode (payload) {
    const envelope = decodeAny(payload)
    const root = await this.getSchema()

    let messageType
    try {
      messageType = root.lookupType(envelope.typeName)
    } catch {
      throw new Error(`The Apollo schema does not contain message type ${envelope.typeName}`)
    }

    const message = messageType.decode(envelope.value)
    return {
      typeUrl: envelope.typeUrl,
      type: envelope.typeName,
      message: messageType.toObject(message, {
        longs: String,
        enums: String,
        bytes: String,
        json: true,
        arrays: true,
        objects: true,
        oneofs: true
      })
    }
  }
}
