import { convolve16 } from '../audio/convolve.mjs'

function firstAboveTwo(track) {
  for (let i = 0; i < track.length; i++) if (Math.abs(track[i]) > 2) return i
  return -1
}

// 用导出件重放探测音，与收音自标记起的整段逐帧核对。
// 规则：每路逐帧差至多 2 码；首个绝对值大于 2 码的帧一致（均未超过也算一致）。
export function verifyReplay(probe, response, segment) {
  const replay = convolve16(probe, response, segment.length)
  let peakDifference = 0
  for (let i = 0; i < segment.length; i++) {
    const difference = Math.abs(replay[i] - segment[i])
    if (difference > peakDifference) peakDifference = difference
    if (difference > 2) return { qualified: false, peakDifference, replay, firstReplay: -1, firstSegment: -1 }
  }
  const firstReplay = firstAboveTwo(replay)
  const firstSegment = firstAboveTwo(segment)
  return { qualified: firstReplay === firstSegment, peakDifference, replay, firstReplay, firstSegment }
}
