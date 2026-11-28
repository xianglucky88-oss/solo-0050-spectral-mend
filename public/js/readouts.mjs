export function showAudio(info) {
  document.querySelector('#source-info').textContent =
    `${info.frames} 帧 · ${info.rate} 赫兹 · ${info.channels === 1 ? '单声道' : '双声道'} · ${info.duration.toFixed(2)} 秒`
  document.querySelector('#max-freq').textContent = `${info.rate / 2} 赫兹`
}

export function showView(view) {
  document.querySelector('#view-start').textContent = `${view.start.toFixed(3)} 秒`
  document.querySelector('#view-end').textContent = `${view.end.toFixed(3)} 秒`
}

export function showMetrics(text, result) {
  if (!result) { text.textContent = ''; return }
  if (result.metrics) {
    const readout = result.metrics.map((channel, index) =>
      `声道 ${index + 1} 峰值 ${channel.originalPeak.toFixed(3)} → ${channel.outputPeak.toFixed(3)}，差值均方根 ${channel.differenceRms.toFixed(5)}，饱和 ${channel.saturation} 帧`)
    text.textContent = [`已处理 ${result.editedWindows} 个时间窗`, ...readout].join(' · ')
  } else {
    text.textContent = `试听扇区已生成，命中 ${result.editedWindows} 个时间窗。`
  }
}
