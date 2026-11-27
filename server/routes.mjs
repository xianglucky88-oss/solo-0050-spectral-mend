import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { machineDemo } from './audio/machine-demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { calibrate, cancelMachine, alignMachine, coverageMachine, evaluateCalibration } from './machine/api.mjs'

// 两件 PCM16 WAV 的 Base64 与字段开销，放宽 JSON 体积边界。
const LIMITS = {
  calibrate: 4_600_000,
  'machine-calibrate': 4_600_000,
  align: 4_600_000,
  'align-reference': 4_600_000,
  audition: 4_600_000,
  cancel: 4_600_000,
  'machine-cancel': 4_600_000,
  'machine-repair': 4_600_000,
  coverage: 4_600_000
}

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (operation === 'machine-demo' && request.method === 'GET') return { body: machineDemo() }
  if (['inspect','repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  if (request.method === 'POST') {
    const machineDispatch = input =>
      (input.action === 'align' || input.preview ? alignMachine(input)
        : input.action === 'coverage' ? coverageMachine(input)
        : (input.repairs || input.generate || input.action === 'cancel' || input.action === 'repair')
          ? cancelMachine(input) : calibrate(input))
    const handlers = {
      calibrate,
      'machine-calibrate': calibrate,
      'reference-calibrate': calibrate,
      'try-calibrate': evaluateCalibration,
      evaluate: evaluateCalibration,
      align: alignMachine,
      'align-reference': alignMachine,
      audition: alignMachine,
      preview: alignMachine,
      coverage: coverageMachine,
      cancel: cancelMachine,
      'machine-cancel': cancelMachine,
      'machine-repair': cancelMachine,
      mend: cancelMachine,
      'remove-machine': cancelMachine,
      machine: machineDispatch
    }
    const handler = handlers[operation]
    if (handler) {
      const input = await readJson(request, LIMITS[operation] ?? 4_600_000)
      return { body: handler(input) }
    }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
