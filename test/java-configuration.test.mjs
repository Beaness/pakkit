import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  createStatePacketQueue,
  installGeneratedPacketBlocker,
  shouldProxyState
} from '../src/proxy/java/configuration.mjs'

const require = createRequire(import.meta.url)
const mc = require('minecraft-protocol')
const minecraftData = require('minecraft-data')

test('minecraft-data supports the newest Java release and configuration state', () => {
  const data = minecraftData('26.1')

  assert.equal(data.version.version, 775)
  assert.equal(data.supportFeature('hasConfigurationState'), true)
  assert.ok(data.protocol.configuration)
})

test('only configuration and play packets are proxied', () => {
  assert.equal(shouldProxyState(mc.states.HANDSHAKING), false)
  assert.equal(shouldProxyState(mc.states.LOGIN), false)
  assert.equal(shouldProxyState(mc.states.CONFIGURATION), true)
  assert.equal(shouldProxyState(mc.states.PLAY), true)
})

test('generated configuration packets are blocked without affecting raw forwarding', () => {
  const client = new EventEmitter()
  const writes = []
  client.write = (name, params) => writes.push({ name, params })
  client.writeRaw = raw => writes.push({ raw })
  client.state = mc.states.CONFIGURATION

  installGeneratedPacketBlocker(client, mc.states.CONFIGURATION, [
    'settings',
    'finish_configuration'
  ])
  client.write('settings', { locale: 'en_us' })
  client.write('custom_payload', { channel: 'example:test' })
  client.writeRaw(Buffer.from([0x01, 0x02]))

  assert.deepEqual(writes, [
    { name: 'custom_payload', params: { channel: 'example:test' } },
    { raw: Buffer.from([0x01, 0x02]) }
  ])
})

test('packets wait for the matching destination phase instead of being dropped', () => {
  const destination = new EventEmitter()
  const forwarded = []
  destination.state = mc.states.LOGIN
  const route = createStatePacketQueue(destination, mc.states, packet => forwarded.push(packet))
  const settings = { meta: { state: mc.states.CONFIGURATION, name: 'settings' } }
  const play = { meta: { state: mc.states.PLAY, name: 'login' } }

  route(settings)
  route(play)
  assert.deepEqual(forwarded, [])

  destination.state = mc.states.CONFIGURATION
  destination.emit('state', destination.state)
  assert.deepEqual(forwarded, [settings])

  destination.state = mc.states.PLAY
  destination.emit('state', destination.state)
  assert.deepEqual(forwarded, [settings, play])
})

test('the final configuration acknowledgement can follow a local PLAY transition', () => {
  const destination = new EventEmitter()
  const forwarded = []
  destination.state = mc.states.PLAY
  const route = createStatePacketQueue(destination, mc.states, packet => forwarded.push(packet))
  const finish = { meta: { state: mc.states.CONFIGURATION, name: 'finish_configuration' } }
  const staleSettings = { meta: { state: mc.states.CONFIGURATION, name: 'settings' } }

  route(finish)
  route(staleSettings)

  assert.deepEqual(forwarded, [finish])
})

test('a reconfiguration acknowledgement can follow an upstream CONFIGURATION transition', () => {
  const destination = new EventEmitter()
  const forwarded = []
  destination.state = mc.states.CONFIGURATION
  const route = createStatePacketQueue(destination, mc.states, packet => forwarded.push(packet))
  const acknowledgement = {
    meta: { state: mc.states.PLAY, name: 'configuration_acknowledged' }
  }

  route(acknowledgement)

  assert.deepEqual(forwarded, [acknowledgement])
})
