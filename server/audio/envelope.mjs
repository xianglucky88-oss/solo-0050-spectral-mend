import { readFrames } from './scan.mjs'

// 有界能量包络：把整段录音降采样到固定点数，每点取该桶内的 RMS。
// 无论录音多长，输出长度恒定（points），读取按桶分块，工作内存不随总帧数增长。
export async function envelope(handle, info, points = 600) {
  const { frames, channels } = info
  const result = new Array(points).fill(0)
  const blockSize = Math.max(1, Math.ceil(frames / points))
  for (let p = 0; p < points; p++) {
    const first = p * blockSize
    if (first >= frames) break
    const count = Math.min(blockSize, frames - first)
    const block = await readFrames(handle, info, first, count)
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const track = block.tracks[c]
      for (let i = 0; i < count; i++) sum += track[i] * track[i]
    }
    result[p] = Math.sqrt(sum / (count * channels))
  }
  const peak = Math.max(...result, 1e-9)
  return result.map(level => Math.min(1, level / peak))
}
