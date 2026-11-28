export function drawWave(canvas, peaks) {
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  ctx.fillStyle = '#111225'
  ctx.fillRect(0, 0, width, height)
  const mid = height / 2, scale = mid - 8
  ctx.strokeStyle = '#3a3350'
  ctx.beginPath()
  ctx.moveTo(0, mid + .5)
  ctx.lineTo(width, mid + .5)
  ctx.stroke()
  ctx.font = '11px system-ui'
  ctx.textAlign = 'left'
  for (const [data, color, name, x] of [[peaks.left, '#f4b6a0b8', '左', width - 58], [peaks.right, '#8fd3d8b8', '右', width - 30]]) {
    if (!data) continue
    ctx.strokeStyle = color
    ctx.beginPath()
    const n = data.length
    for (let px = 0; px < width; px++) {
      const [mn, mx] = data[Math.min(n - 1, Math.floor(px * n / width))]
      ctx.moveTo(px + .5, mid - mx * scale)
      ctx.lineTo(px + .5, mid - mn * scale + 1)
    }
    ctx.stroke()
    ctx.fillStyle = color.replace('b8', 'ff')
    ctx.fillText(name, x, 16)
  }
}

export function drawCircle(canvas, circle, duration) {
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  if (!circle || !duration) return
  const x0 = circle.start / duration * width, x1 = circle.end / duration * width
  ctx.fillStyle = '#0b0a16b3'
  ctx.fillRect(0, 0, x0, height)
  ctx.fillRect(x1, 0, width - x1, height)
  ctx.fillStyle = '#fff4ca14'
  ctx.fillRect(x0, 0, x1 - x0, height)
  ctx.strokeStyle = '#fff4ca'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x0, 0); ctx.lineTo(x0, height)
  ctx.moveTo(x1, 0); ctx.lineTo(x1, height)
  ctx.stroke()
  ctx.lineWidth = 1
}

export function circleDrag(canvas, getDuration, onPreview, onCommit) {
  let first = null
  const fraction = event => {
    const box = canvas.getBoundingClientRect()
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
  }
  canvas.onpointerdown = event => {
    if (!getDuration() || event.button !== 0) return
    first = fraction(event)
    canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointermove = event => {
    if (first === null || !getDuration()) return
    const now = fraction(event), duration = getDuration()
    onPreview({ start: Math.min(first, now) * duration, end: Math.max(first, now) * duration })
  }
  canvas.onpointerup = event => {
    if (first === null || !getDuration()) return
    const now = fraction(event), duration = getDuration()
    const start = Math.min(first, now) * duration, end = Math.max(first, now) * duration
    first = null
    if (end - start >= 0.04) onCommit(start, end)
    else onPreview(null)
  }
  canvas.onpointercancel = () => {
    if (first === null) return
    first = null
    onPreview(null)
  }
}
