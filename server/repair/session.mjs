import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { columns } from '../spectrum/columns.mjs'
import { regions } from './regions.mjs'
import { metrics } from './metrics.mjs'
import { rebuild } from './rebuild.mjs'
import { cancelMachine as repairWithReference } from '../machine/api.mjs'

export {
  calibrate,
  calibrate as calibrateMachine,
  evaluateCalibration,
  evaluateCalibration as tryCalibrate,
  cancelMachine,
  cancelMachine as cancel,
  cancelMachine as mend,
  cancelMachine as removeMachine,
  cancelMachine as repairMachine,
  cancelMachine as machineRepair,
  alignMachine,
  alignMachine as align,
  alignMachine as audition,
  coverageMachine,
  coverageMachine as coverage
} from '../machine/api.mjs'
export { repairWithReference }

export function inspect(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  return { rate: audio.rate, frames: audio.frames, channels: audio.tracks.length, spectrum: columns(audio, plan) }
}

// 当请求带有同一台机器的参考录音时，进入“双件校准 + 参考相减”工作流；
// 否则保持原有频谱选区修复行为不变。
function wantsReferenceWorkflow(input) {
  if (!input || !(input.referenceWav || typeof input.reference === 'string' ||
      (input.reference && typeof input.reference === 'object' && input.reference.wav))) return false
  if (input.mode === 'machine') return true
  if (input.repairs || input.first || input.second || input.calibration || input.cal) return true
  // 仅有频谱框（含 low/high/db）时仍走原有频谱衰减；纯 start/end 区间按修复区处理。
  if (Array.isArray(input.regions) && input.regions.length &&
      input.regions.every(r => r && Number.isFinite(r.low) && Number.isFinite(r.high))) return false
  return Boolean(Array.isArray(input.regions))
}

export function repair(input) {
  if (wantsReferenceWorkflow(input)) return repairWithReference(input)
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  const edited = rebuild(audio, plan, regions(input.regions, audio))
  return { wav: encode(edited).toString('base64'), editedWindows: edited.editedWindows,
    metrics: metrics(audio, edited), spectrum: columns(edited, plan) }
}
