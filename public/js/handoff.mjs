import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'

const q = selector => document.querySelector(selector)

function parseList(value) {
  return value.split(',').map(token => Number(token.trim())).filter(Number.isFinite)
}

export function handoffPanel(ctx) {
  const probeForm = q('#probe-form')
  let bundle, preparedWav, resultWav, workingWav

  const prepareStatus = text => { q('#prepare-status').textContent = text }
  const commitStatus = text => { q('#commit-status').textContent = text }

  // 当主工作台已有选区与录音时，预填核听帧范围。
  function syncProbe() {
    const view = ctx.view()
    if (!view) return
    probeForm.elements.first.value = 0
    probeForm.elements.last.value = view.frames - 1
  }
  ctx.onSource(syncProbe)

  q('#prepare').onclick = async () => {
    try {
      const source = ctx.sourceWav()
      if (!source) throw new Error('请先在上方打开录音。')
      const first = Number(probeForm.elements.first.value)
      const last = Number(probeForm.elements.last.value)
      const frequencies = parseList(probeForm.elements.frequencies.value)
      const retainedRaw = probeForm.elements.retained.value.trim()
      const retained = retainedRaw ? parseList(retainedRaw) : []
      const regions = ctx.regions()
      if (!regions.length) throw new Error('请先在频谱上添加至少一个选区。')
      const payload = {
        wav: source,
        size: ctx.size(),
        items: [{ id: `item-${Date.now()}`, regions, segment: { first, last }, frequencies, retained }],
      }
      const prepared = await request('handoff-prepare', payload)
      bundle = prepared.bundle
      preparedWav = bundle.source.wav
      renderItems()
      const nonUnique = bundle.items.filter(item => !item.readingsUnique)
      q('#download-bundle').disabled = q('#download-prepared-wav').disabled = false
      q('#commit').disabled = q('#reopen').disabled = false
      prepareStatus(nonUnique.length
        ? `打包 ${bundle.items.length} 项；${nonUnique.length} 项读数不唯一，不得核准。`
        : `已打包 ${bundle.items.length} 个核听项，读数均唯一，可交接。`)
    } catch (error) { prepareStatus(error.message) }
  }

  q('#download-bundle').onclick = () =>
    download(new Blob([JSON.stringify(bundle)], { type: 'application/json' }), 'handoff-bundle.json')
  q('#download-prepared-wav').onclick = () => download(wavBlob(preparedWav), 'source-pcm16.wav')
  q('#download-result').onclick = () => download(wavBlob(resultWav), 'merged-pcm16.wav')

  q('#bundle-file').onchange = async event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    try {
      bundle = JSON.parse(await file.text())
      workingWav = bundle.source.wav
      preparedWav = bundle.source.wav
      renderItems()
      q('#commit').disabled = q('#reopen').disabled = false
      commitStatus(`已载入含 ${bundle.items.length} 项、${bundle.merges.length} 条合入记录的交接包。`)
    } catch (error) { commitStatus('交接记录无法读取。') }
  }

  q('#working-file').onchange = async event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (file) { workingWav = await fromFile(file); commitStatus('已载入接收稿 WAV。') }
  }

  function renderItems() {
    const host = q('#commit-items')
    host.replaceChildren(...bundle.items.map(item => {
      const card = document.createElement('div')
      card.className = 'commit-item'
      const head = document.createElement('header')
      const title = document.createElement('span')
      title.textContent = `${item.id} · ${item.memberIds?.length ?? 1} 选区 · ${item.editedMask.flat().length} 写位样点`
      const state = document.createElement('span')
      state.className = 'state'
      state.textContent = item.readingsUnique ? '待核准' : '读数不唯一'
      head.append(title, state)

      const retained = document.createElement('label')
      retained.innerHTML = '授权重做并保留带外频点（逗号分隔，留空=普通合入）'
      const retainedInput = document.createElement('input')
      retainedInput.type = 'text'
      retainedInput.dataset.role = 'retained'
      retainedInput.placeholder = (item.retained ?? []).join(',') || '带外频点'
      retained.append(retainedInput)

      const readings = document.createElement('div')
      readings.className = 'readings'
      readings.textContent = item.readings.after.map((channel, c) =>
        `声道${c + 1}: ` + channel.map(r => r.frequency === 0
          ? `直流${r.cosine.toFixed(1)}`
          : `${r.frequency}Hz[${r.cosine.toFixed(1)},${r.sine.toFixed(1)}]`).join('  ')).join('\n')

      card.append(head, retained, readings)
      card.dataset.id = item.id
      return card
    }))
  }

  function authorizations() {
    return [...q('#commit-items').children].map(card => {
      const value = card.querySelector('[data-role=retained]').value.trim()
      if (!value) return { id: card.dataset.id }
      return { id: card.dataset.id, redo: true, retained: parseList(value) }
    })
  }

  q('#commit').onclick = async () => {
    try {
      if (!bundle) throw new Error('请先载入交接记录。')
      const result = await request('handoff-commit', {
        wav: workingWav ?? bundle.source.wav, bundle, authorizations: authorizations(),
      })
      bundle = result.bundle
      resultWav = result.wav
      workingWav = result.wav
      renderStates(result.results)
      q('#download-result').disabled = false
      const retainedCount = result.results.filter(r => r.state === 'retained' || r.state === 'conflict').length
      commitStatus(retainedCount
        ? `${retainedCount} 项保留接收稿，其余照常合入。`
        : '全部可合入项已合入，读数与写位核验通过。')
    } catch (error) { commitStatus(error.message) }
  }

  q('#reopen').onclick = async () => {
    try {
      if (!bundle) throw new Error('请先载入交接记录。')
      const result = await request('handoff-reopen', { wav: workingWav ?? bundle.source.wav, bundle })
      renderStates(result.records.map(record => ({ id: record.id, state: record.state })))
      commitStatus(`重开核验：${result.records.filter(r => r.state === 'merged').length} 项凭记录与读数确认已合入。`)
    } catch (error) { commitStatus(error.message) }
  }

  function renderStates(results) {
    for (const card of q('#commit-items').children) {
      const match = results.find(r => r.id === card.dataset.id)
      if (!match) continue
      const state = card.querySelector('.state')
      state.className = `state ${match.state}`
      state.textContent = match.reason ? `${match.state}：${match.reason}` : match.state
    }
  }

  return { enable: () => { q('#prepare').disabled = false } }
}
