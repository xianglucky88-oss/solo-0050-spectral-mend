import { spectralColor } from './palette.mjs'

// 渲染当前视区的谱图。spectrum.centers 的时间是原始录音坐标，
// 这里把它们线性映射到画布宽度；视区外的内容不参与绘制。
export function spectrogram(canvas, spectrum) {
  const ctx = canvas.getContext('2d')
  const values = spectrum.values
  const bins = values[0].length, width = canvas.width, height = canvas.height
  const bitmap = ctx.createImageData(width, height)
  const colors = new Map()
  const { viewStart, viewEnd, duration } = spectrum
  const xBounds = spectrum.centers.map((group, i) => i === values.length - 1
    ? Math.min(viewEnd, duration)
    : (group.last + spectrum.centers[i + 1].first) / 2)
  let column = 0
  for (let x = 0; x < width; x++) {
    const t = viewStart + (x + .5) / width * (viewEnd - viewStart)
    while (t > xBounds[column] && column < values.length - 1) column++
    for (let y = 0; y < height; y++) {
      const k = Math.round((1 - (y + .5) / height) * (bins - 1))
      const db = values[column][k]
      if (!colors.has(db)) colors.set(db, [...spectralColor(db), 255])
      bitmap.data.set(colors.get(db), (y * width + x) * 4)
    }
  }
  ctx.putImageData(bitmap, 0, 0)
}
