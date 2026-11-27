export function overlays(canvas, regions, duration, rate) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = '#fff4ca'; ctx.fillStyle = '#fff4ca26'; ctx.lineWidth = 2
  regions.forEach(region => {
    const x = region.start / duration * width, y = (1 - region.high / (rate / 2)) * height
    const w = (region.end - region.start) / duration * width, h = (region.high - region.low) / (rate / 2) * height
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h)
  })
}
