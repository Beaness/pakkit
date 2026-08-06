import assert from 'node:assert/strict'
import test from 'node:test'

import { appendVisiblePacketRows } from '../src/renderer/visiblePacketRows.mjs'

test('the first visible packet batch is not duplicated through a shared Clusterize array', () => {
  const visibleRows = []
  let clusterRows = visibleRows
  const append = rows => {
    // Clusterize append() replaces its internal rows with concat(), but its
    // initial rows still reference visibleRows when this function is called.
    clusterRows = clusterRows.concat(rows)
  }

  appendVisiblePacketRows(visibleRows, ['brand', 'settings'], append)
  appendVisiblePacketRows(visibleRows, ['registry'], append)

  assert.deepEqual(visibleRows, ['brand', 'settings', 'registry'])
  assert.deepEqual(clusterRows, ['brand', 'settings', 'registry'])
})
