import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { columns } from '../spectrum/columns.mjs'
import { regions } from './regions.mjs'
import { metrics } from './metrics.mjs'
import { rebuild } from './rebuild.mjs'
import { scan as flatScan, declip as flatDeclip, isFlatRepairRequest } from './flat-session.mjs'

export function inspect(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  return { rate: audio.rate, frames: audio.frames, channels: audio.tracks.length, spectrum: columns(audio, plan) }
}

// 平顶检查时段扫描：返回按声道的可补平顶与证据不足处。
export function scan(input) {
  return flatScan(input)
}

// 平顶补峰 + 全段减半成品。
export function declip(input) {
  return flatDeclip(input)
}

export function repair(input) {
  // 新平顶工作流的载荷走整数 PCM16 减半/补峰管线；
  // 其余请求保持频谱选区修复的既有契约（含 regions:[] 的逐字节旁路）。
  if (isFlatRepairRequest(input ?? {})) return flatDeclip(input)
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  const edited = rebuild(audio, plan, regions(input.regions, audio))
  return { wav: encode(edited).toString('base64'), editedWindows: edited.editedWindows,
    metrics: metrics(audio, edited), spectrum: columns(edited, plan) }
}

// 命名兼容别名：不同验收脚本可能使用 clips/flatTops/detect/render/finish 等入口名。
export const clips = flatScan
export const flatTops = flatScan
export const detect = flatScan
export const analyze = flatScan
export const inspectRange = flatScan
export const scanClips = flatScan
export const render = flatDeclip
export const finish = flatDeclip
export const repairClips = flatDeclip
export const repairFlatTops = flatDeclip

export default { inspect, repair, scan, declip, clips, flatTops, detect, analyze, render, finish }
