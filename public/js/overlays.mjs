// 选区覆盖层。选区用原始录音坐标存储，按当前视区与奈奎斯特频率映射到画布，
// 因此平移、缩放、切换窗长后，选区仍落在原始时频位置。视区外的框被裁剪。
export function overlays(canvas, regions, view, rate, playhead) {
  const ctx = canvas.getContext('2d'), { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  const span = view.end - view.start
  const xOf = time => (time - view.start) / span * width
  const widthOf = (start, end) => (end - start) / span * width
  ctx.strokeStyle = '#fff4ca'; ctx.fillStyle = '#fff4ca26'; ctx.lineWidth = 2
  regions.forEach(region => {
    if (region.end <= view.start || region.start >= view.end) return
    const x = xOf(Math.max(region.start, view.start))
    const w = widthOf(Math.max(region.start, view.start), Math.min(region.end, view.end))
    const y = (1 - region.high / (rate / 2)) * height
    const h = (region.high - region.low) / (rate / 2) * height
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h)
  })
  if (Number.isFinite(playhead) && playhead >= view.start && playhead < view.end) {
    const px = xOf(playhead)
    ctx.strokeStyle = '#7ee0ff'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, height); ctx.stroke()
  }
}
