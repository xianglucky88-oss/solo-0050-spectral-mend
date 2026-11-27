// Draws the circled hum period, the locating points and the per-window
// confirmation status over the spectrum. Every unconfirmed window is drawn
// individually so merged, missing and ambiguous places each stay visible and
// are kept as-is rather than glued into a repair range.
export function overlays(canvas, state, duration, rate) {
  const ctx = canvas.getContext('2d'), { width, height } = canvas
  const x = time => time / duration * width
  const y = frequency => (1 - frequency / (rate / 2)) * height
  ctx.clearRect(0, 0, width, height)
  const { regions, circle, points, trace } = state
  for (const region of regions) {
    ctx.strokeStyle = '#fff4ca'; ctx.fillStyle = '#fff4ca22'; ctx.lineWidth = 2
    ctx.fillRect(x(region.start), y(region.high), x(region.end) - x(region.start),
      y(region.low) - y(region.high))
    ctx.strokeRect(x(region.start), y(region.high), x(region.end) - x(region.start),
      y(region.low) - y(region.high))
  }
  let top = 0, bottom = height
  if (circle) {
    const left = x(circle.start), right = x(circle.end)
    top = y(circle.high); bottom = y(circle.low)
    ctx.save()
    ctx.setLineDash([7, 5]); ctx.strokeStyle = '#8fd6ff'; ctx.fillStyle = '#8fd6ff14'; ctx.lineWidth = 2
    ctx.fillRect(left, top, right - left, bottom - top)
    ctx.strokeRect(left, top, right - left, bottom - top)
    ctx.restore()
  }
  if (trace) {
    for (const window of trace.windows ?? []) {
      if (window.status === 'double') continue
      ctx.fillStyle = window.status === 'missing' ? '#f3a0a0'
        : window.status === 'ambiguous' ? '#f2d27a' : '#c3a7ff'
      ctx.globalAlpha = .75
      ctx.fillRect(x(window.time) - 1.5, top, 3, bottom - top)
      ctx.globalAlpha = 1
    }
    for (const segment of trace.confirmed ?? []) {
      ctx.strokeStyle = '#87e0b0'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(x(segment.center.time), height - 10, 4, 0, Math.PI * 2); ctx.stroke()
    }
  }
  ctx.fillStyle = '#ffd166'; ctx.strokeStyle = '#ffd166'
  if (points.length > 1) {
    ctx.save()
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5
    ctx.beginPath()
    points.forEach((point, index) => {
      const px = x(point.time), py = y(point.frequency)
      if (index === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.stroke()
    ctx.restore()
  }
  points.forEach((point, index) => {
    const px = x(point.time), py = y(point.frequency)
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(px - 7, py - 7); ctx.lineTo(px + 7, py + 7)
    ctx.moveTo(px + 7, py - 7); ctx.lineTo(px - 7, py + 7); ctx.stroke()
    ctx.font = '12px system-ui'; ctx.fillText(String(index + 1), px + 9, py - 9)
  })
}
