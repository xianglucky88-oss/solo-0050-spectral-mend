import { wavBlob } from './wave-asset.mjs'

export function audition(player) {
  let url, position = 0
  player.addEventListener('loadedmetadata', () => {
    player.currentTime = Math.min(position, player.duration)
    position = 0
  })
  return (wav, keepPosition) => {
    position = keepPosition && player.readyState > 0 ? player.currentTime : keepPosition ? position : 0
    const resume = keepPosition && !player.paused
    if (url) URL.revokeObjectURL(url)
    url = URL.createObjectURL(wavBlob(wav))
    player.src = url
    if (resume) player.play().catch(() => {})
  }
}
