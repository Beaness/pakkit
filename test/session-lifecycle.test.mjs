import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { replaceSessionIpcListeners } from '../src/ipcSessionHandlers.mjs'
import { stopSessionAndLoadStart } from '../src/sessionLifecycle.mjs'

test('returning to setup disposes handlers, stops the proxy, then loads the start page', async () => {
  const calls = []
  const error = await stopSessionAndLoadStart({
    activeProxy: { end: () => calls.push('stop') },
    disposePacketHandlers: () => calls.push('dispose'),
    loadStartPage: async () => calls.push('load')
  })

  assert.equal(error, undefined)
  assert.deepEqual(calls, ['dispose', 'stop', 'load'])
})

test('the start page still loads when proxy shutdown reports an error', async () => {
  const calls = []
  const expected = new Error('shutdown failed')
  const error = await stopSessionAndLoadStart({
    activeProxy: { end: () => { throw expected } },
    disposePacketHandlers: () => calls.push('dispose'),
    loadStartPage: async () => calls.push('load')
  })

  assert.equal(error, expected)
  assert.deepEqual(calls, ['dispose', 'load'])
})

test('packet IPC handlers do not accumulate across sessions', () => {
  const ipc = new EventEmitter()
  let clientWrites = 0
  let dispose = replaceSessionIpcListeners(undefined, ipc, {
    injectPacket: () => assert.fail('stale injection handler was called'),
    scriptStateChange: () => assert.fail('stale script handler was called')
  })
  dispose = replaceSessionIpcListeners(dispose, ipc, {
    injectPacket: () => { clientWrites++ },
    scriptStateChange: () => {}
  })

  assert.equal(ipc.listenerCount('injectPacket'), 1)
  assert.equal(ipc.listenerCount('scriptStateChange'), 1)

  ipc.emit('injectPacket')
  assert.equal(clientWrites, 1)

  dispose()
  assert.equal(ipc.listenerCount('injectPacket'), 0)
  assert.equal(ipc.listenerCount('scriptStateChange'), 0)
})
