import { prepare } from './engine.mjs'
import { commit } from './commit.mjs'
import { reopen, inspectCopy } from './reopen.mjs'
import { decode } from '../audio/decode.mjs'
import { audioHash } from './pcm.mjs'
import { toCodes } from './pcm.mjs'

// 发送方打包交接记录：附带未编辑原件 WAV 与逐项核听读数。
export function handoffPrepare(input) {
  const result = prepare(input)
  const audio = decode(input.wav)
  const sourceHash = audioHash(toCodes(audio), audio.rate)
  if (sourceHash !== result.source.hash) throw new Error('原件指纹不一致。')
  const bundle = {
    version: 1,
    source: { wav: input.wav, rate: result.source.rate, frames: result.source.frames,
      channels: result.source.channels, size: result.source.size, hash: sourceHash },
    items: result.items.map(item => ({
      id: item.ids.join('+'),
      memberIds: item.ids,
      regions: item.regions,
      segment: item.segment,
      frequencies: item.frequencies,
      retained: item.retained,
      frames: item.frames,
      editedMask: item.editedMask,
      editedWindows: item.editedWindows,
      clips: item.clips,
      readingsUnique: item.readingsUnique,
      readings: item.readings,
      toneApprovals: item.toneApprovals,
    })),
    merges: [],
  }
  return { source: result.source, bundle }
}

// 接收方按项合入 / 授权重做 / 保留接收稿。
export function handoffCommit(input) {
  return commit(input)
}

// 重开核验：凭合入记录与吻合修后读数标记已合入。
export function handoffReopen(input) {
  return reopen(input)
}

// 无记录 WAV：同一 PCM 另存仍按本地副本判冲突。
export function handoffCopy(input) {
  return inspectCopy(input)
}
