// PCM16 码值布局：所有核听读数与合入判定都在量化后的整数码值上进行。

export function toCodes(audio) {
  return audio.tracks.map(track => Int16Array.from(track, value =>
    Math.max(-32768, Math.min(32767, Math.round(value * 32768)))))
}

export function codesToTracks(codes, frames) {
  return codes.map(channel => Float64Array.from(channel, value => value / 32768))
}

export function tracksFromCodes(codes, rate, frames) {
  return { tracks: codesToTracks(codes, frames), rate, frames }
}

// 量化后是否落在 PCM16 饱和边界（会削波）。
export function clips(audio) {
  return toCodes(audio).some(channel => channel.some(value => value === -32768 || value === 32767))
}

// 修复是否相对底本新引入量化溢出（饱和帧），与 repair/metrics 的口径一致：
// 浮点码值四舍五入后越过 PCM16 范围即记一次溢出。
export function introducesClipping(base, rebuilt) {
  const baseCodes = toCodes(base)
  return rebuilt.tracks.some((track, channel) => {
    for (let i = 0; i < track.length; i++) {
      const quantized = Math.round(track[i] * 32768)
      if ((quantized < -32768 || quantized > 32767) &&
        !(baseCodes[channel][i] === -32768 || baseCodes[channel][i] === 32767)) return true
    }
    return false
  })
}

export function codeHash(codes) {
  let hash = 0x811c9dc5
  for (const channel of codes) for (const value of channel) {
    hash ^= value & 0xffff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function audioHash(codes, rate) {
  return `${rate}-${codes.length}-${codeHash(codes)}`
}
