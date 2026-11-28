// 拖选输出的选区始终使用原始录音的秒/赫兹坐标，与当前视区无关。
// 画布的相对位置先映射回视区时间，再加上视区起点。
export function selection(canvas, getContext, commit) {
  let first
  function point(event) {
    const box = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }
  }
  function toTime(x, ctx) {
    return ctx.view.start + x * (ctx.view.end - ctx.view.start)
  }
  canvas.onpointerdown = event => {
    const ctx = getContext()
    if (!ctx || event.button !== 0) return
    first = point(event)
    canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointercancel = () => { first = undefined }
  canvas.onpointerup = event => {
    const ctx = getContext()
    if (!first || !ctx) return
    const second = point(event)
    if (Math.abs(second.x - first.x) > .003 && Math.abs(second.y - first.y) > .003) {
      commit({
        start: toTime(Math.min(first.x, second.x), ctx),
        end: toTime(Math.max(first.x, second.x), ctx),
        low: (1 - Math.max(first.y, second.y)) * ctx.rate / 2,
        high: (1 - Math.min(first.y, second.y)) * ctx.rate / 2
      })
    }
    first = undefined
  }
}
