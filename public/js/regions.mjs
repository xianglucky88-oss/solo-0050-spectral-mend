import { MAX_REGIONS } from './limits.mjs'

export function fields(form, region) {
  for (const [name, value] of Object.entries(region)) form.elements[name].value = value
}

export function regionFrom(form, duration, limit) {
  const entry = name => form.elements[name].value.trim() === '' ? NaN : Number(form.elements[name].value)
  const region = Object.fromEntries(['start', 'end', 'low', 'high', 'db'].map(name => [name, entry(name)]))
  const { start, end, low, high, db } = region
  if (!Object.values(region).every(Number.isFinite) || start < 0 || end > duration || start >= end ||
      low < 0 || high > limit || low >= high || db < 0 || db > 60) {
    throw new Error('请检查时段、频带与衰减范围。')
  }
  return region
}

export function showRegions(list, regions, remove) {
  list.replaceChildren(...regions.map(({ start, end, low, high, db }, index) => {
    const row = document.createElement('li'), button = document.createElement('button')
    row.textContent = `${start.toFixed(2)}–${end.toFixed(2)} 秒 / ${Math.round(low)}–${Math.round(high)} 赫兹 / ${db} dB`
    button.type = 'button'; button.textContent = '移除'; button.onclick = () => remove(index)
    row.append(button)
    return row
  }))
}

export function assertCapacity(count) {
  if (count >= MAX_REGIONS) throw new Error(`最多保留 ${MAX_REGIONS} 个选区。`)
}
