export function selection(canvas, dimensions, commit) {
  let first
  function point(event) {
    const box = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }
  }
  canvas.onpointerdown = event => {
    if (!dimensions() || event.button !== 0) return
    first = point(event)
    canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointercancel = () => { first = undefined }
  canvas.onpointerup = event => {
    if (!first || !dimensions()) return
    const second = point(event), { duration, rate } = dimensions()
    if (Math.abs(second.x - first.x) > .003 && Math.abs(second.y - first.y) > .003) {
      commit({ start: Math.min(first.x, second.x) * duration, end: Math.max(first.x, second.x) * duration,
        low: (1 - Math.max(first.y, second.y)) * rate / 2, high: (1 - Math.min(first.y, second.y)) * rate / 2 })
    }
    first = undefined
  }
}
