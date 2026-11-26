import { request } from './request.mjs'

const q = selector => document.querySelector(selector)

function parseList(text, label) {
  const values = text.split(',').map(part => part.trim()).filter(part => part !== '').map(Number)
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) {
    throw new Error(`${label}需要是逗号分隔的数值。`)
  }
  return values
}

export function glideParams(form) {
  const value = name => form.elements[name].value.trim()
  const number = name => {
    const parsed = Number(value(name))
    if (!Number.isFinite(parsed)) throw new Error('上滑音参数需要全部填写为数值。')
    return parsed
  }
  const orders = parseList(value('gorders'), '谐波阶数')
  if (!orders.every(Number.isInteger) || orders.some(order => order < 1)) {
    throw new Error('谐波阶数需要是正整数。')
  }
  const sidebands = parseList(value('gsidebands'), '边带半宽')
  if (sidebands.length !== 1 && sidebands.length !== orders.length) {
    throw new Error('边带半宽数量应与谐波阶数一致，或只填一个统一值。')
  }
  return {
    start: number('gstart'),
    end: number('gend'),
    low: number('glow'),
    high: number('ghigh'),
    orders,
    sidebands,
    targetStart: number('gtargetStart'),
    targetEnd: number('gtargetEnd'),
  }
}

export function fillGlideForm(form, params) {
  form.elements.gstart.value = params.start
  form.elements.gend.value = params.end
  form.elements.glow.value = params.low
  form.elements.ghigh.value = params.high
  form.elements.gorders.value = params.orders.join(',')
  form.elements.gsidebands.value = params.sidebands.join(',')
  form.elements.gtargetStart.value = params.targetStart
  form.elements.gtargetEnd.value = params.targetEnd
}

// 谱图拖选后回填时段与基频搜索范围（频带中点作为基频初值参考）。
export function fillGlideFromRegion(form, region) {
  form.elements.gstart.value = region.start
  form.elements.gend.value = region.end
  if (!form.elements.glow.value) form.elements.glow.value = Math.max(1, Math.round(region.low))
  if (!form.elements.ghigh.value) form.elements.ghigh.value = Math.round(region.high)
}

export function showFindings(list, result) {
  list.replaceChildren()
  if (!result) return
  if (result.f0) {
    const head = document.createElement('li')
    head.className = result.ok ? 'ok' : 'blocked'
    head.textContent = `辨认基频 ${result.f0.toFixed(2)} Hz`
    list.append(head)
  }
  if (Array.isArray(result.bands)) {
    for (const band of result.bands) {
      const row = document.createElement('li')
      row.textContent = `第 ${band.order} 阶载频 ${band.carrier.toFixed(1)} Hz，声明频带 ${band.low.toFixed(1)}–${band.high.toFixed(1)} Hz`
      list.append(row)
    }
  }
}

export function showGlideMetrics(text, result) {
  if (!result?.metrics) {
    text.textContent = ''
    return
  }
  const readout = result.metrics.map((channel, index) =>
    `声道 ${index + 1} 峰值 ${channel.originalPeak.toFixed(3)} → ${channel.outputPeak.toFixed(3)}，差值均方根 ${channel.differenceRms.toFixed(5)}，饱和 ${channel.saturation} 帧`)
  text.textContent = [`已处理 ${result.editedWindows ?? 0} 个分析窗`, ...readout].join(' · ')
}

export async function inspectGlide(wav, params) {
  return request('glide-inspect', { wav, ...params })
}

export async function applyGlide(wav, params, size) {
  return request('glide', { wav, size, ...params })
}
