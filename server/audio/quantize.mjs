// PCM16 码域量化：32768 为满幅倍率，半码远离零，超幅裁至 PCM16 范围。
export function quantizeCode(value) {
  const rounded = value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5)
  if (rounded > 32767) return 32767
  if (rounded < -32768) return -32768
  return rounded
}

// 浮点采样（以 32768 满幅表示）转 PCM16 码。
export function sampleToCode(sample) {
  return quantizeCode(sample * 32768)
}

export function codeToSample(code) {
  return code / 32768
}

export const PCM_MIN = -32768
export const PCM_MAX = 32767
