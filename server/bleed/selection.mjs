import { InputError } from '../http/error.mjs'

const MAX_SOLOS = 3

function frameRange(entry, audio, label) {
  if (!entry || typeof entry !== 'object') throw new InputError(`${label}需要有效的时段。`)
  let startFrame, endFrame
  if (Number.isInteger(entry.startFrame) && Number.isInteger(entry.endFrame)) {
    startFrame = entry.startFrame
    endFrame = entry.endFrame
  } else if (Number.isFinite(entry.start) && Number.isFinite(entry.end)) {
    startFrame = Math.round(entry.start * audio.rate)
    endFrame = Math.round(entry.end * audio.rate)
  } else {
    throw new InputError(`${label}需要开始与结束（秒或帧号）。`)
  }
  if (startFrame < 0 || endFrame > audio.frames || endFrame - startFrame < 2) {
    throw new InputError(`${label}超出录音范围或过短。`)
  }
  return { start: startFrame / audio.rate, end: endFrame / audio.rate, startFrame, endFrame }
}

/**
 * 解析“每路三段独奏 + 待修节目”的选择。
 *
 * 接受 `{ solos, program }` 或 `{ calibration: { solos, program } }`；
 * 时段可用秒（start/end）或帧号（startFrame/endFrame）。服务端统一换算为
 * 帧号，避免客户端舍入差异。独奏只要求同一路内互不重叠；节目需与全部
 * 独奏分开，即“校准”与“待修”不共用时段。
 */
export function selection(input, audio) {
  if (audio.tracks.length !== 2) throw new InputError('串漏校准需要双声道 PCM16 节目。')
  const payload = input?.calibration ?? input
  const rawSolos = payload?.solos
  if (!Array.isArray(rawSolos) || rawSolos.length !== 2) {
    throw new InputError('需要为两个声道各圈定至多三段独奏。')
  }
  const solos = rawSolos.map((list, channel) => {
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SOLOS) {
      throw new InputError(`声道 ${channel + 1} 需要圈定 1–${MAX_SOLOS} 段独奏。`)
    }
    const segments = list.map((entry, index) =>
      frameRange(entry, audio, `声道 ${channel + 1} 的第 ${index + 1} 段独奏`))
    const sorted = [...segments].sort((a, b) => a.startFrame - b.startFrame)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startFrame < sorted[i - 1].endFrame) {
        throw new InputError(`声道 ${channel + 1} 的独奏区间之间不能重叠。`)
      }
    }
    return segments
  })
  if (!payload?.program) throw new InputError('需要圈定与校准分开的待修节目。')
  const program = frameRange(payload.program, audio, '待修节目')
  for (const segment of solos.flat()) {
    if (program.startFrame < segment.endFrame && segment.startFrame < program.endFrame) {
      throw new InputError('待修节目需要与校准独奏分开，不能重叠。')
    }
  }
  return { solos, program }
}
