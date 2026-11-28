// 全景小地图：用固定长度的能量包络概括整段录音，并标出当前视区。
// 包络在打开时由服务端一次性计算（有界长度），视区变化只重绘视区边框。
export function minimap(canvas, envelope, view, duration) {
  const ctx = canvas.getContext('2d'), { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#1b1a2e'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#695875'; ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
  ctx.fillStyle = '#8f7bb0'
  const step = width / envelope.length
  envelope.forEach((level, i) => {
    const h = Math.max(1, level * (height - 6))
    ctx.fillRect(i * step, height - 3 - h, Math.max(1, step - .5), h)
  })
  const x = view.start / duration * width
  const w = (view.end - view.start) / duration * width
  ctx.fillStyle = '#f4b6a033'; ctx.strokeStyle = '#f4b6a0'; ctx.lineWidth = 1.5
  ctx.fillRect(x, 0, w, height); ctx.strokeRect(x + .5, .5, w - 1, height - 1)
}
