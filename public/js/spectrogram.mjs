import { spectralColor } from './palette.mjs'

export function spectrogram(canvas, spectrum) {
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.createImageData !== 'function' || !spectrum?.values?.length) return
  const values = spectrum.values
  const bins = values[0].length, width = canvas.width, height = canvas.height
  const bitmap = ctx.createImageData(width, height)
  const colors = new Map()
  const xBounds = spectrum.centers.map((group, i) => i === values.length - 1 ? spectrum.duration :
    (group.last + spectrum.centers[i + 1].first) / 2)
  let column = 0
  for (let x = 0; x < width; x++) {
    const t = (x + .5) / width * spectrum.duration
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
