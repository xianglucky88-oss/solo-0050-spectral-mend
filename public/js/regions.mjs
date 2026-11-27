export function fields(form, values) {
  for (const [name, value] of Object.entries(values)) {
    if (form.elements[name]) form.elements[name].value = value
  }
}

function number(form, name) {
  const value = form.elements[name].value.trim()
  return value === '' ? NaN : Number(value)
}

export function regionFrom(form, duration, limit) {
  const region = Object.fromEntries(['start','end','low','high','db'].map(name => [name, number(form, name)]))
  const { start, end, low, high, db } = region
  if (!Object.values(region).every(Number.isFinite) || start < 0 || end > duration || start >= end ||
      low < 0 || high > limit || low >= high || db < 0 || db > 60) throw new Error('请检查时段、频带与衰减范围。')
  return region
}

export function circleFrom(form, duration, limit) {
  const circle = Object.fromEntries(['start','end','low','high'].map(name => [name, number(form, name)]))
  const { start, end, low, high } = circle
  if (!Object.values(circle).every(Number.isFinite) || start < 0 || end > duration || start >= end ||
      low < 0 || high > limit || low >= high) throw new Error('圈定需要有效的起止时间与频带。')
  const tone = number(form, 'db')
  if (!Number.isFinite(tone) || tone < 6 || tone > 60) throw new Error('嗡声衰减需要在 6–60 dB 之间。')
  return { range: circle, db: tone }
}

export function showRegions(list, regions, remove) {
  list.replaceChildren(...regions.map(({start,end,low,high,db}, index) => {
    const row = document.createElement('li'), button = document.createElement('button')
    row.textContent = `${start.toFixed(2)}–${end.toFixed(2)} 秒 / ${Math.round(low)}–${Math.round(high)} 赫兹 / ${db} dB`
    button.type = 'button'; button.textContent = '移除'; button.onclick = () => remove(index)
    row.append(button)
    return row
  }))
}

export function showPoints(list, points, remove) {
  if (!points.length) {
    const row = document.createElement('li')
    row.className = 'empty'
    row.textContent = '尚未放置定位点；交会前后各点一次嗡声。'
    list.replaceChildren(row)
    return
  }
  list.replaceChildren(...points.map((point, index) => {
    const row = document.createElement('li'), button = document.createElement('button')
    row.textContent = `第 ${index + 1} 点 · ${point.time.toFixed(3)} 秒 · ${Math.round(point.frequency)} 赫兹`
    button.type = 'button'; button.textContent = '移除'; button.onclick = () => remove(index)
    row.append(button)
    return row
  }))
}

// Per-window confirmation list. Confirmed runs come first with their
// center-window check; every unconfirmed window is listed separately with its
// reason so merged, missing and ambiguous places stay visible one by one.
export function showTrials(list, report) {
  if (!report) {
    const row = document.createElement('li')
    row.className = 'empty'
    row.textContent = '圈定后在此查看逐窗确认结果。'
    list.replaceChildren(row)
    return
  }
  const rows = []
  const { summary } = report
  for (const issue of report.issues ?? []) {
    const row = document.createElement('li')
    row.className = 'unconfirmed'
    row.textContent = `定位点未通过：${issue}`
    rows.push(row)
  }
  const heading = document.createElement('li')
  heading.className = 'summary'
  heading.textContent = `共 ${summary.analysed} 个分析窗 · 双峰 ${summary.double} · 合峰 ${summary.merged} · ` +
    `缺声 ${summary.missing} · 归属不明 ${summary.ambiguous}`
  rows.push(heading)
  for (const segment of report.confirmed) {
    const row = document.createElement('li')
    row.className = 'confirmed'
    const check = (report.verification ?? []).find(entry => Math.abs(entry.time - segment.center.time) < 1e-6)
    row.textContent = `已确认 ${segment.start.toFixed(3)}–${segment.end.toFixed(3)} 秒（${segment.count} 窗）` +
      ` · 居中窗 ${segment.center.time.toFixed(3)} 秒 · 嗡声 ${segment.center.humFrequency} 赫兹 → ` +
      `伴随音 ${segment.center.companionFrequency} 赫兹` +
      (check ? ` · 嗡声降 ${check.humDropDb} dB · 伴随音变 ${check.companionNotchChangeDb ?? check.companionChangeDb} dB` : '')
    rows.push(row)
  }
  for (const entry of report.unconfirmed) {
    const row = document.createElement('li')
    row.className = 'unconfirmed'
    const label = entry.status === 'unverified' ? '未通过核对'
      : entry.status === 'short-run' ? '连续窗不足'
      : entry.status === 'missing' ? '缺声'
      : entry.status === 'ambiguous' ? '归属不明' : '合峰'
    row.textContent = `未确认 · ${entry.time.toFixed(3)} 秒 · ${label}（${entry.reason}）` +
      (entry.candidate
        ? ` · 可补点：嗡声 ${entry.candidate.humFrequency} 赫兹与伴随音 ${entry.candidate.companionFrequency} 赫兹相距 ${entry.candidate.separation} 格`
        : entry.humFrequency ? ` · 嗡声 ${entry.humFrequency} 赫兹` : '')
    if (entry.candidate) {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = '补点'
      button.dataset.time = entry.candidate.time
      button.dataset.frequency = entry.candidate.humFrequency
      button.className = 'suggest'
      row.append(button)
    }
    rows.push(row)
  }
  list.replaceChildren(...rows)
}
