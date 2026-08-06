const RANGE_LABELS = {
  10000: 'Last 10 seconds',
  30000: 'Last 30 seconds',
  60000: 'Last minute',
  300000: 'Last 5 minutes',
  all: 'Entire capture'
}

const SHARE_COLORS = ['#7c8cff', '#ff7885', '#66d986', '#f8c35b', '#b783ff', '#596273']

let sharedVars
let elements
let selectedRange = 30000
let selectedDirection = 'all'
let useCompressedSize = true
let replayEnd
let renderScheduled = false
let lastSnapshot
let lastRenderAt = 0
let chartHovering = false

function packetByteSize (packet) {
  if (useCompressedSize && Number.isFinite(packet.compressedByteSize) && packet.compressedByteSize >= 0) {
    return packet.compressedByteSize
  }
  if (Number.isFinite(packet.byteSize) && packet.byteSize >= 0) return packet.byteSize
  if (Number.isFinite(packet.raw?.length)) return packet.raw.length
  if (Number.isFinite(packet.raw?.data?.length)) return packet.raw.data.length
  return 0
}

function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1) return `${bytes.toFixed(2).replace(/\.?0+$/, '')} B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1))
  const value = bytes / Math.pow(1000, unitIndex)
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function formatRate (bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`
}

function formatCount (count) {
  return count.toLocaleString()
}

function directionLabel (direction) {
  return direction === 'clientbound' ? 'Clientbound' : 'Serverbound'
}

function getCaptureEnd () {
  return replayEnd ?? Date.now()
}

function niceMaximum (value) {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const magnitude = Math.pow(10, exponent)
  const normalized = value / magnitude
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return rounded * magnitude
}

function calculateSnapshot () {
  const end = getCaptureEnd()
  const rangeIsAll = selectedRange === 'all'
  let start = rangeIsAll ? end : end - selectedRange
  const packets = []

  for (let index = sharedVars.allPackets.length - 1; index >= 0; index--) {
    const packet = sharedVars.allPackets[index]
    const size = packetByteSize(packet)
    const time = Number(packet.time)
    if (size <= 0 || !Number.isFinite(time) || time > end) continue
    if (!rangeIsAll && time < start) break
    if (selectedDirection !== 'all' && packet.direction !== selectedDirection) continue
    packets.push({ packet, size, time })
    if (rangeIsAll && time < start) start = time
  }

  if (rangeIsAll && packets.length === 0) {
    start = end - 1000
  }

  const durationMs = Math.max(1000, end - start)
  const bucketCount = rangeIsAll
    ? 60
    : Math.min(60, Math.max(20, Math.round(selectedRange / 1000)))
  const bucketDuration = durationMs / bucketCount
  const buckets = Array.from({ length: bucketCount }, () => ({ clientbound: 0, serverbound: 0 }))
  const packetTypes = new Map()
  let totalBytes = 0
  let compressedPacketCount = 0

  for (const entry of packets) {
    const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((entry.time - start) / bucketDuration)))
    buckets[bucketIndex][entry.packet.direction] += entry.size
    totalBytes += entry.size
    if (entry.packet.wasCompressed) compressedPacketCount++

    const name = entry.packet.meta?.name ?? 'unknown'
    const key = `${entry.packet.direction}:${name}`
    const current = packetTypes.get(key) ?? { name, direction: entry.packet.direction, count: 0, bytes: 0 }
    current.count++
    current.bytes += entry.size
    packetTypes.set(key, current)
  }

  const bucketSeconds = bucketDuration / 1000
  const bucketRates = buckets.map(bucket => ({
    clientbound: bucket.clientbound / bucketSeconds,
    serverbound: bucket.serverbound / bucketSeconds
  }))
  const rankedTypes = [...packetTypes.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.name.localeCompare(b.name))
  const average = totalBytes / (durationMs / 1000)
  const peak = bucketRates.reduce((highest, bucket) => Math.max(highest, bucket.clientbound + bucket.serverbound), 0)

  return { start, end, durationMs, bucketSeconds, bucketRates, rankedTypes, totalBytes, average, peak, packetCount: packets.length, compressedPacketCount }
}

function createSvgElement (name, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value)
  return element
}

function smoothPath (points, property) {
  if (points.length === 0) return ''
  let path = `M ${points[0].x} ${points[0][property]}`
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index]
    const next = points[index + 1]
    const midpoint = (current.x + next.x) / 2
    path += ` C ${midpoint} ${current[property]}, ${midpoint} ${next[property]}, ${next.x} ${next[property]}`
  }
  return path
}

function renderChart (snapshot) {
  const width = 960
  const height = 238
  const left = 62
  const right = 14
  const top = 12
  const bottom = 29
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maximum = niceMaximum(Math.max(snapshot.peak, snapshot.average))
  const svg = createSvgElement('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Bandwidth chart. Average ${formatRate(snapshot.average)}, peak ${formatRate(snapshot.peak)}.`
  })

  const definitions = createSvgElement('defs')
  const gradient = createSvgElement('linearGradient', { id: 'bandwidth-total-gradient', x1: '0', y1: '0', x2: '0', y2: '1' })
  gradient.append(
    createSvgElement('stop', { offset: '0%', 'stop-color': '#7c8cff', 'stop-opacity': '0.3' }),
    createSvgElement('stop', { offset: '100%', 'stop-color': '#7c8cff', 'stop-opacity': '0.015' })
  )
  definitions.appendChild(gradient)
  svg.appendChild(definitions)

  for (let line = 0; line <= 4; line++) {
    const y = top + (plotHeight * line / 4)
    svg.appendChild(createSvgElement('line', { class: 'chart-grid-line', x1: left, x2: width - right, y1: y, y2: y }))
    const label = createSvgElement('text', { class: 'chart-axis-label', x: left - 9, y: y + 4, 'text-anchor': 'end' })
    label.textContent = formatRate(maximum * (1 - line / 4))
    svg.appendChild(label)
  }

  const step = plotWidth / Math.max(1, snapshot.bucketRates.length - 1)
  const points = snapshot.bucketRates.map((bucket, index) => {
    const x = left + index * step
    return {
      x,
      totalY: top + plotHeight - ((bucket.clientbound + bucket.serverbound) / maximum * plotHeight),
      clientboundY: top + plotHeight - (bucket.clientbound / maximum * plotHeight),
      serverboundY: top + plotHeight - (bucket.serverbound / maximum * plotHeight)
    }
  })
  const totalPath = smoothPath(points, 'totalY')
  const totalArea = createSvgElement('path', {
    class: 'chart-total-area',
    d: `${totalPath} L ${points.at(-1).x} ${top + plotHeight} L ${points[0].x} ${top + plotHeight} Z`
  })
  svg.appendChild(totalArea)

  if (selectedDirection === 'all' || selectedDirection === 'clientbound') {
    svg.appendChild(createSvgElement('path', { class: 'chart-series-line clientbound', d: smoothPath(points, 'clientboundY') }))
  }
  if (selectedDirection === 'all' || selectedDirection === 'serverbound') {
    svg.appendChild(createSvgElement('path', { class: 'chart-series-line serverbound', d: smoothPath(points, 'serverboundY') }))
  }
  svg.appendChild(createSvgElement('path', { class: 'chart-series-line total', d: totalPath }))

  if (snapshot.average > 0) {
    const averageY = top + plotHeight - (snapshot.average / maximum * plotHeight)
    svg.appendChild(createSvgElement('line', { class: 'chart-average-line', x1: left, x2: width - right, y1: averageY, y2: averageY }))
  }

  const hoverMarker = createSvgElement('g', { class: 'chart-hover-marker', visibility: 'hidden' })
  hoverMarker.append(
    createSvgElement('line', { class: 'chart-hover-crosshair', x1: 0, x2: 0, y1: top, y2: top + plotHeight }),
    createSvgElement('circle', { class: 'chart-hover-point total', cx: 0, cy: 0, r: 4 }),
    createSvgElement('circle', { class: 'chart-hover-point clientbound', cx: 0, cy: 0, r: 3 }),
    createSvgElement('circle', { class: 'chart-hover-point serverbound', cx: 0, cy: 0, r: 3 })
  )
  svg.appendChild(hoverMarker)

  const timestamps = [snapshot.start, snapshot.start + snapshot.durationMs / 2, snapshot.end]
  timestamps.forEach((timestamp, index) => {
    const label = createSvgElement('text', {
      class: 'chart-time-label',
      x: left + plotWidth * index / 2,
      y: height - 7,
      'text-anchor': index === 0 ? 'start' : index === 2 ? 'end' : 'middle'
    })
    label.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    svg.appendChild(label)
  })

  const hoverSurface = createSvgElement('rect', {
    class: 'chart-hover-surface',
    x: left,
    y: top,
    width: plotWidth,
    height: plotHeight
  })
  svg.appendChild(hoverSurface)

  const tooltip = document.createElement('div')
  tooltip.className = 'bandwidth-chart-tooltip'
  tooltip.hidden = true
  const tooltipTime = document.createElement('strong')
  const tooltipTotal = document.createElement('span')
  const tooltipClientbound = document.createElement('span')
  const tooltipServerbound = document.createElement('span')
  tooltip.append(tooltipTime, tooltipTotal, tooltipClientbound, tooltipServerbound)

  function hideTooltip () {
    chartHovering = false
    hoverMarker.setAttribute('visibility', 'hidden')
    tooltip.hidden = true
    scheduleRender()
  }

  hoverSurface.addEventListener('pointermove', event => {
    chartHovering = true
    const bounds = svg.getBoundingClientRect()
    const viewX = (event.clientX - bounds.left) / bounds.width * width
    const pointIndex = Math.min(points.length - 1, Math.max(0, Math.round((viewX - left) / step)))
    const point = points[pointIndex]
    const bucket = snapshot.bucketRates[pointIndex]
    const total = bucket.clientbound + bucket.serverbound
    const timestamp = snapshot.start + snapshot.durationMs * pointIndex / Math.max(1, points.length - 1)

    hoverMarker.setAttribute('visibility', 'visible')
    hoverMarker.setAttribute('transform', `translate(${point.x} 0)`)
    hoverMarker.querySelector('.chart-hover-point.total').setAttribute('cy', point.totalY)
    const clientboundPoint = hoverMarker.querySelector('.chart-hover-point.clientbound')
    const serverboundPoint = hoverMarker.querySelector('.chart-hover-point.serverbound')
    clientboundPoint.setAttribute('cy', point.clientboundY)
    serverboundPoint.setAttribute('cy', point.serverboundY)
    clientboundPoint.setAttribute('display', selectedDirection === 'serverbound' ? 'none' : '')
    serverboundPoint.setAttribute('display', selectedDirection === 'clientbound' ? 'none' : '')

    tooltipTime.textContent = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    tooltipTotal.textContent = `Total  ${formatRate(total)}`
    tooltipClientbound.textContent = `Clientbound  ${formatRate(bucket.clientbound)}`
    tooltipServerbound.textContent = `Serverbound  ${formatRate(bucket.serverbound)}`
    tooltipClientbound.hidden = selectedDirection === 'serverbound'
    tooltipServerbound.hidden = selectedDirection === 'clientbound'
    tooltip.hidden = false

    const chartBounds = elements.chart.getBoundingClientRect()
    const tooltipWidth = tooltip.offsetWidth
    const pointerX = event.clientX - chartBounds.left
    tooltip.style.left = `${Math.max(8, Math.min(pointerX + 14, chartBounds.width - tooltipWidth - 8))}px`
    tooltip.style.top = `${Math.max(8, event.clientY - chartBounds.top - tooltip.offsetHeight - 12)}px`
  })
  hoverSurface.addEventListener('pointerleave', hideTooltip)

  document.querySelectorAll('[data-chart-direction]').forEach(legendItem => {
    legendItem.hidden = selectedDirection !== 'all' && legendItem.dataset.chartDirection !== selectedDirection
  })
  elements.chart.replaceChildren(svg, tooltip)
}

function renderShare (snapshot) {
  const topTypes = snapshot.rankedTypes.slice(0, 5)
  const usedBytes = topTypes.reduce((sum, packetType) => sum + packetType.bytes, 0)
  const slices = topTypes.map((packetType, index) => ({
    ...packetType,
    color: SHARE_COLORS[index]
  }))
  if (snapshot.totalBytes > usedBytes) {
    slices.push({ name: 'Other packets', bytes: snapshot.totalBytes - usedBytes, color: SHARE_COLORS[5] })
  }

  let percentage = 0
  const stops = slices.map(slice => {
    const start = percentage
    percentage += snapshot.totalBytes > 0 ? slice.bytes / snapshot.totalBytes * 100 : 0
    return `${slice.color} ${start}% ${percentage}%`
  })
  elements.shareDonut.style.background = stops.length > 0
    ? `conic-gradient(${stops.join(', ')})`
    : 'var(--surface-3)'
  elements.shareTotal.textContent = formatBytes(snapshot.totalBytes)

  const legendItems = slices.map(slice => {
    const item = document.createElement('li')
    const label = document.createElement('span')
    const swatch = document.createElement('span')
    const name = document.createElement('span')
    const share = document.createElement('strong')
    swatch.className = 'packet-share-swatch'
    swatch.style.background = slice.color
    name.textContent = slice.direction ? `${slice.name} · ${directionLabel(slice.direction)}` : slice.name
    label.append(swatch, name)
    share.textContent = snapshot.totalBytes > 0 ? `${(slice.bytes / snapshot.totalBytes * 100).toFixed(1)}%` : '0%'
    item.append(label, share)
    return item
  })
  elements.shareLegend.replaceChildren(...legendItems)
}

function renderRanking (snapshot) {
  const query = elements.search.value.trim().toLowerCase()
  const filteredTypes = snapshot.rankedTypes.filter(packetType => {
    return packetType.name.toLowerCase().includes(query) || directionLabel(packetType.direction).toLowerCase().includes(query)
  })
  const visibleTypes = filteredTypes.slice(0, 200)
  const rows = visibleTypes.map((packetType, index) => {
    const row = document.createElement('tr')
    const packetCell = document.createElement('td')
    const bar = document.createElement('span')
    const rank = document.createElement('span')
    const name = document.createElement('span')
    const directionCell = document.createElement('td')
    const direction = document.createElement('span')
    const countCell = document.createElement('td')
    const averageCell = document.createElement('td')
    const totalCell = document.createElement('td')
    const shareCell = document.createElement('td')
    const share = snapshot.totalBytes > 0 ? packetType.bytes / snapshot.totalBytes * 100 : 0

    packetCell.className = 'ranking-packet-cell'
    bar.className = `ranking-byte-bar ${packetType.direction}`
    bar.style.width = `${share}%`
    rank.className = 'ranking-position'
    rank.textContent = String(index + 1)
    name.className = 'ranking-packet-name'
    name.textContent = packetType.name
    packetCell.append(bar, rank, name)

    direction.className = `direction-badge ${packetType.direction}`
    direction.textContent = directionLabel(packetType.direction)
    directionCell.appendChild(direction)

    for (const cell of [countCell, averageCell, totalCell, shareCell]) cell.className = 'number-column'
    countCell.textContent = formatCount(packetType.count)
    averageCell.textContent = formatBytes(packetType.bytes / packetType.count)
    totalCell.textContent = formatBytes(packetType.bytes)
    totalCell.title = `${formatCount(packetType.bytes)} ${useCompressedSize ? 'measured' : 'raw'} bytes`
    shareCell.textContent = `${share.toFixed(1)}%`
    row.append(packetCell, directionCell, countCell, averageCell, totalCell, shareCell)
    return row
  })

  elements.rankingBody.replaceChildren(...rows)
  elements.rankingEmpty.hidden = visibleTypes.length > 0
  if (snapshot.rankedTypes.length === 0) {
    elements.rankingEmpty.textContent = 'Waiting for raw packet data…'
  } else if (filteredTypes.length === 0) {
    elements.rankingEmpty.textContent = 'No packet types match your search.'
  }
  elements.rankingSummary.textContent = filteredTypes.length > visibleTypes.length
    ? `Showing the first ${formatCount(visibleTypes.length)} of ${formatCount(filteredTypes.length)} packet types`
    : `${formatCount(filteredTypes.length)} packet ${filteredTypes.length === 1 ? 'type' : 'types'} in this window`
}

function render () {
  renderScheduled = false
  lastRenderAt = Date.now()
  chartHovering = false
  const snapshot = calculateSnapshot()
  lastSnapshot = snapshot
  const rangeLabel = RANGE_LABELS[selectedRange]
  const largest = snapshot.rankedTypes[0]

  elements.average.textContent = formatRate(snapshot.average)
  elements.averageDetail.textContent = `Across ${rangeLabel.toLowerCase()} · ${useCompressedSize ? 'compressed' : 'raw'} sizes`
  elements.total.textContent = formatBytes(snapshot.totalBytes)
  elements.totalDetail.textContent = useCompressedSize && snapshot.compressedPacketCount > 0
    ? `${formatCount(snapshot.packetCount)} packets · ${formatCount(snapshot.compressedPacketCount)} compressed`
    : `${formatCount(snapshot.packetCount)} measured ${snapshot.packetCount === 1 ? 'packet' : 'packets'}`
  elements.peak.textContent = formatRate(snapshot.peak)
  elements.peakDetail.textContent = `Highest ${snapshot.bucketSeconds < 1 ? snapshot.bucketSeconds.toFixed(1) : Math.round(snapshot.bucketSeconds)} second interval`
  elements.largestType.textContent = largest?.name ?? '—'
  elements.largestDetail.textContent = largest
    ? `${formatBytes(largest.bytes)} · ${(largest.bytes / snapshot.totalBytes * 100).toFixed(1)}% of traffic`
    : 'No measured packets'
  elements.windowLabel.textContent = rangeLabel
  elements.rankingMeasureLabel.textContent = useCompressedSize
    ? 'Ordered by compressed size when available'
    : 'Ordered by raw packet bytes'
  elements.unavailable.hidden = sharedVars.proxyCapabilities.rawData !== false || snapshot.packetCount > 0

  renderChart(snapshot)
  renderShare(snapshot)
  renderRanking(snapshot)
}

function scheduleRender () {
  if (renderScheduled || chartHovering) return
  renderScheduled = true
  const delay = Math.max(0, 500 - (Date.now() - lastRenderAt))
  window.setTimeout(() => window.requestAnimationFrame(render), delay)
}

function isViewOpen () {
  return document.getElementById('Bandwidth').style.display === 'block'
}

export function setup (passedSharedVars) {
  sharedVars = passedSharedVars
  elements = {
    range: document.getElementById('bandwidth-range'),
    useCompressed: document.getElementById('bandwidth-use-compressed'),
    average: document.getElementById('bandwidth-average'),
    averageDetail: document.getElementById('bandwidth-average-detail'),
    total: document.getElementById('bandwidth-total'),
    totalDetail: document.getElementById('bandwidth-total-detail'),
    peak: document.getElementById('bandwidth-peak'),
    peakDetail: document.getElementById('bandwidth-peak-detail'),
    largestType: document.getElementById('bandwidth-largest-type'),
    largestDetail: document.getElementById('bandwidth-largest-detail'),
    windowLabel: document.getElementById('bandwidth-window-label'),
    chart: document.getElementById('bandwidth-chart'),
    shareDonut: document.getElementById('packet-share-donut'),
    shareTotal: document.getElementById('packet-share-total'),
    shareLegend: document.getElementById('packet-share-legend'),
    rankingBody: document.getElementById('packet-ranking-body'),
    rankingEmpty: document.getElementById('packet-ranking-empty'),
    rankingSummary: document.getElementById('packet-ranking-summary'),
    rankingMeasureLabel: document.getElementById('packet-ranking-measure-label'),
    search: document.getElementById('bandwidth-search'),
    unavailable: document.getElementById('bandwidth-unavailable')
  }

  elements.range.addEventListener('change', () => {
    selectedRange = elements.range.value === 'all' ? 'all' : Number(elements.range.value)
    render()
  })
  elements.useCompressed.addEventListener('change', () => {
    useCompressedSize = elements.useCompressed.checked
    render()
  })
  document.querySelectorAll('.bandwidth-direction-filter button').forEach(button => {
    button.addEventListener('click', () => {
      selectedDirection = button.dataset.direction
      document.querySelectorAll('.bandwidth-direction-filter button').forEach(option => {
        const active = option === button
        option.classList.toggle('active', active)
        option.setAttribute('aria-pressed', String(active))
      })
      render()
    })
  })
  elements.search.addEventListener('input', () => {
    if (lastSnapshot) renderRanking(lastSnapshot)
  })

  window.setInterval(() => {
    if (isViewOpen() && replayEnd === undefined) scheduleRender()
  }, 1000)
  render()
}

export function packetAdded () {
  replayEnd = undefined
  if (isViewOpen()) scheduleRender()
}

export function logLoaded () {
  replayEnd = sharedVars.allPackets.reduce((latest, packet) => Math.max(latest, Number(packet.time) || 0), 0) || undefined
  scheduleRender()
}

export function reset () {
  replayEnd = undefined
  scheduleRender()
}

export function viewOpened () {
  render()
}
