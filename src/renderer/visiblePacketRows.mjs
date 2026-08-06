// Clusterize keeps the rows array passed to its constructor/update by
// reference until append() replaces its internal value with a concatenated
// copy. Append first so updating our own mirror cannot add the same first
// batch to Clusterize a second time through that shared reference.
export function appendVisiblePacketRows (visibleRows, newRows, append) {
  append(newRows)
  for (const row of newRows) visibleRows.push(row)
}
