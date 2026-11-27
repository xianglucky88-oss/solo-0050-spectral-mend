// Pointer interaction for the spectrum canvas. In `region` and `circle` modes
// a drag defines a time/frequency rectangle; in `point` mode a tap places a
// locating point for the hum route. The context callback supplies the current
// duration, Nyquist frequency and mode, so the module stays stateless.
export function selection(canvas, context, handlers) {
  let first
  const point = event => {
    const box = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))
    }
  }
  const locate = (coords, { duration, rate }) => ({
    time: coords.x * duration,
    frequency: (1 - coords.y) * rate / 2
  })
  const range = (a, b, { duration, rate }) => ({
    start: Math.min(a.x, b.x) * duration,
    end: Math.max(a.x, b.x) * duration,
    low: (1 - Math.max(a.y, b.y)) * rate / 2,
    high: (1 - Math.min(a.y, b.y)) * rate / 2
  })
  canvas.onpointerdown = event => {
    const dimensions = context()
    if (!dimensions || event.button !== 0) return
    first = point(event)
    canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointercancel = () => { first = undefined }
  canvas.onpointerup = event => {
    const dimensions = context()
    if (!first || !dimensions) return
    const second = point(event)
    const dragged = Math.abs(second.x - first.x) > .003 && Math.abs(second.y - first.y) > .003
    if (dimensions.mode === 'point') {
      if (!dragged) handlers.point(locate(second, dimensions))
    } else if (dragged) {
      const box = range(first, second, dimensions)
      if (dimensions.mode === 'circle') handlers.circle(box)
      else handlers.region(box)
    }
    first = undefined
  }
}
