const DB_MIN = -96, DB_MAX = 3
const STATUS_COLOR = { cancel: '#f4b6a0', single: '#8fd3d8', normal: '#6f6484', empty: '#3a3450' }

const fmtHz = value => value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : `${value}`

export function drawBands(canvas, bands) {
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  ctx.fillStyle = '#111225'
  ctx.fillRect(0, 0, width, height)
  const left = 78, right = 14, top = 30, bottom = 46
  const plotW = width - left - right, plotH = height - top - bottom
  const y = db => top + (DB_MAX - db) / (DB_MAX - DB_MIN) * plotH
  const dbOf = ma => 20 * Math.log10(Math.max(ma, 1e-4) / 32768)
  ctx.font = '10px system-ui'
  for (const [ma, label] of [[32768, '32768 码'], [8192, '8192 码'], [2048, '2048 码'], [512, '512 码'],
      [128, '128 码'], [32, '32 码'], [8, '8 码 · 有效下限']]) {
    const yy = y(dbOf(ma))
    ctx.strokeStyle = ma === 8 ? '#df9c89' : '#2c2841'
    ctx.beginPath()
    ctx.moveTo(left, yy)
    ctx.lineTo(width - right, yy)
    ctx.stroke()
    ctx.fillStyle = ma === 8 ? '#df9c89' : '#8f86a3'
    ctx.textAlign = 'right'
    ctx.fillText(label, left - 6, yy + 3)
  }
  ctx.fillStyle = '#8f86a3'
  ctx.textAlign = 'left'
  ctx.fillText('电平 / 码（对数刻度）', 6, 16)
  const legend = [['合计有效电平', '#f4b6a0'], ['等权折叠', '#8fd3d8']]
  let legendX = width - right - 190
  for (const [name, color] of legend) {
    ctx.fillStyle = color
    ctx.fillRect(legendX, 8, 10, 10)
    ctx.fillStyle = '#d9c6e6'
    ctx.fillText(name, legendX + 14, 17)
    legendX += 14 + name.length * 10 + 26
  }
  const n = bands.length
  const group = plotW / n
  const barW = Math.min(26, group * 0.3)
  const floor = y(dbOf(0))
  bands.forEach((band, i) => {
    const cx = left + (i + 0.5) * group
    if (band.status === 'cancel') {
      ctx.fillStyle = '#f4b6a012'
      ctx.fillRect(cx - group / 2 + 2, top, group - 4, plotH)
    }
    for (const [ma, color, side] of [[band.combined, '#f4b6a0', -1], [band.fold, '#8fd3d8', 1]]) {
      const x = cx + side * 2 + (side < 0 ? -barW : 0)
      const topY = y(dbOf(ma))
      ctx.fillStyle = color
      ctx.fillRect(x, topY, barW, floor - topY)
      ctx.textAlign = 'center'
      ctx.fillText(String(Math.round(ma)), cx + side * (barW / 2 + 2), topY - 3)
    }
    ctx.fillStyle = '#d9c6e6'
    ctx.textAlign = 'center'
    ctx.fillText(`${fmtHz(band.low)}–${fmtHz(band.high)}`, cx, height - 28)
    ctx.fillStyle = STATUS_COLOR[band.status]
    ctx.beginPath()
    ctx.arc(cx, height - 13, 4, 0, 7)
    ctx.fill()
  })
}
