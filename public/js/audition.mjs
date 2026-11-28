// 单播放器对听控件：原声与修复声共享同一个 <audio>，切换时延续当前播放位置。
// 每次试听是一段带原始起点的 WAV，播放位置按段内相对时间维护。
export function audition(player) {
  let url, segmentStart = 0, segmentEnd = 0
  player.addEventListener('loadedmetadata', () => {
    if (player.dataset.seek !== undefined) {
      player.currentTime = Number(player.dataset.seek)
      delete player.dataset.seek
    }
  })
  return {
    // payload 是 base64 WAV；range 给出该段在原始录音中的起止秒。
    play(payload, range, { keepPosition, signal }) {
      const relative = keepPosition && player.readyState > 0
        ? Math.max(0, Math.min(player.currentTime, range.end - range.start)) : 0
      const wasPlaying = keepPosition && !player.paused
      if (url) URL.revokeObjectURL(url)
      const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0))
      url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      segmentStart = range.start
      segmentEnd = range.end
      player.dataset.seek = String(relative)
      player.src = url
      if (wasPlaying || signal === 'play') player.play().catch(() => {})
    },
    // 当前播放位置对应的原始录音时间，用于画播放头。
    absoluteTime() {
      if (!player.duration || Number.isNaN(player.currentTime)) return null
      return segmentStart + player.currentTime
    },
    segment() { return { start: segmentStart, end: segmentEnd } }
  }
}
