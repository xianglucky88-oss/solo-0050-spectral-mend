export function showAudio(view) {
  document.querySelector('#source-info').textContent = `${view.frames} 帧 · ${view.rate} 赫兹 · ${view.channels === 1 ? '单声道' : '双声道'}`
  document.querySelector('#max-time').textContent = `${view.spectrum.duration.toFixed(3)} 秒`
  document.querySelector('#max-freq').textContent = `${view.rate / 2} 赫兹`
}

export function showMetrics(text, result) {
  if (!result) { text.textContent = ''; return }
  const readout = result.metrics.map((channel, index) =>
    `声道 ${index + 1} 峰值 ${channel.originalPeak.toFixed(3)} → ${channel.outputPeak.toFixed(3)}，差值均方根 ${channel.differenceRms.toFixed(5)}，饱和 ${channel.saturation} 帧`)
  text.textContent = [`已处理 ${result.editedWindows} 个时间窗`, ...readout].join(' · ')
}
