import { decodePcm } from './decode-pcm.mjs'

export function decode(base64) {
  const pcm = decodePcm(base64)
  const tracks = pcm.codes.map(channel => Float64Array.from(channel, code => code / 32768))
  return { tracks, rate: pcm.rate, frames: pcm.frames }
}
