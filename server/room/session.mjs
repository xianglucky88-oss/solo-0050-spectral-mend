import { InputError } from '../http/error.mjs'
import { decodePcm } from '../audio/decode-pcm.mjs'
import { encode16 } from '../audio/encode16.mjs'
import { convolve16 } from '../audio/convolve.mjs'
import { deconvolve } from './deconvolve.mjs'
import { refineResponse } from './refine.mjs'
import { verifyReplay } from './verify.mjs'

const MAX_ROOM_BASE64 = 4_000_000

function integerField(input, name) {
  const value = input?.[name]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InputError(`${name} 应为整数帧号。`)
  }
  return value
}

function isSilent(track) {
  for (let i = 0; i < track.length; i++) if (track[i] !== 0) return false
  return true
}

export function roomExport(input) {
  const probePcm = decodePcm(input?.probe, MAX_ROOM_BASE64)
  const capturePcm = decodePcm(input?.capture, MAX_ROOM_BASE64)
  if (probePcm.channels !== 1) throw new InputError('探测音须为单声道 PCM16 WAV。')
  if (capturePcm.channels !== 2) throw new InputError('收音须为双声道 PCM16 WAV。')
  if (probePcm.rate !== capturePcm.rate) {
    throw new InputError('探测音与收音须为同一采样率。')
  }
  if (isSilent(probePcm.codes[0])) throw new InputError('探测音为静音，无法提取房间响应。')
  const marker = integerField(input, 'marker')
  const responseFrames = integerField(input, 'responseFrames')
  if (responseFrames < 1) throw new InputError('响应帧数至少为 1。')
  if (marker < 0 || marker >= capturePcm.frames) {
    throw new InputError('收音起播标记须位于收音范围内。')
  }
  // 标记起须覆盖完整尾部：probe * response 的全部输出帧。
  if (marker + probePcm.frames + responseFrames - 1 > capturePcm.frames) {
    throw new InputError('收音缺尾，自标记起不足以容纳探测音与响应的完整尾部。')
  }
  const segmentFrames = probePcm.frames + responseFrames - 1
  const probe = probePcm.codes[0]
  const channels = capturePcm.codes.map((captureTrack, channel) => {
    const segment = captureTrack.subarray(marker, marker + segmentFrames)
    const leastSquares = deconvolve(probe, segment, responseFrames)
    // 在整数码网格上微调，使实际重放与收音的逐帧差最小（满足至多 2 码）。
    const response = refineResponse(probe, segment, leastSquares)
    const check = verifyReplay(probe, response, segment)
    return { response, check, channel }
  })
  const failed = channels.find(({ check }) => !check.qualified)
  if (failed) {
    throw new InputError(`指定长度无合格响应：声道 ${failed.channel + 1} 重放与收音不一致（最大差 ${failed.check.peakDifference} 码）。`)
  }
  const wav = encode16({ channels: 2, rate: capturePcm.rate,
    codes: channels.map(({ response }) => response) })
  return {
    wav: wav.toString('base64'),
    rate: capturePcm.rate,
    frames: responseFrames,
    channels: 2,
    marker,
    checks: channels.map(({ check, channel }) => ({
      channel: channel + 1,
      peakDifference: check.peakDifference,
      firstAboveTwo: check.firstReplay
    }))
  }
}

export function roomProof(input) {
  // 房间响应是本系统产出的受控数据，可短至 1 帧；干声仍按外部输入要求至少 16 帧。
  const responsePcm = decodePcm(input?.response, MAX_ROOM_BASE64, { minFrames: 1 })
  const dryPcm = decodePcm(input?.dry, MAX_ROOM_BASE64)
  if (responsePcm.channels !== 2) throw new InputError('房间响应须为双声道 PCM16 WAV。')
  if (dryPcm.channels !== 1) throw new InputError('干声须为单声道 PCM16 WAV。')
  if (responsePcm.rate !== dryPcm.rate) throw new InputError('干声与房间响应须为同一采样率。')
  const dry = dryPcm.codes[0]
  const outputFrames = dry.length + responsePcm.frames - 1
  const codes = responsePcm.codes.map(responseTrack => convolve16(dry, responseTrack, outputFrames))
  const wav = encode16({ channels: 2, rate: dryPcm.rate, codes })
  return { wav: wav.toString('base64'), rate: dryPcm.rate, frames: outputFrames, channels: 2 }
}
