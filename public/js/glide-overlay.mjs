// 上滑音叠加层：辨识后画各阶声明频带，生成后画从原载频到目标载频的扫动轨迹。
export function glideOverlay(canvas, params, analysis, result, duration, nyquist) {
  if (!params || !analysis?.bands) return
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  const xOf = time => time / duration * width
  const yOf = freq => (1 - freq / nyquist) * height

  if (analysis?.bands) {
    ctx.strokeStyle = '#8fd3ff'
    ctx.fillStyle = '#8fd3ff22'
    ctx.lineWidth = 1.5
    for (const band of analysis.bands) {
      const x = xOf(params.start), w = (params.end - params.start) / duration * width
      const y = yOf(band.high), h = (band.high - band.low) / nyquist * height
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    }
  }

  if (result && analysis?.bands) {
    ctx.strokeStyle = '#ffd27a'
    ctx.lineWidth = 2
    for (const band of analysis.bands) {
      const fromFreq = band.order * params.targetStart
      const toFreq = band.order * params.targetEnd
      ctx.beginPath()
      ctx.moveTo(xOf(params.start), yOf(fromFreq))
      ctx.lineTo(xOf(params.end), yOf(toFreq))
      ctx.stroke()
    }
  }
}
