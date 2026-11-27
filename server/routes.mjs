import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { inspectWorkbench, repairWorkbench, workbenchDemo } from './workbench/session.mjs'

const norm = operation => String(operation ?? '')
  .replace(/[/_\s]+/g, '-')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase()

const TOPIC = /(workbench|bench|timeline|arrange|arrangement|compose|composition|splice|montage|studio|sequence|clip|take|occurrence|appearance|segment|piece)/
const REPAIR_ACTION = /(repair|render|mend|export|apply|build|master|finish|bake|mix|produce|generate|process)/
const INSPECT_ACTION = /(inspect|scan|read|analy|preview|spectrum|spectro|view|probe|detect|list|layout|box)/
const DEMO_ACTION = /(demo|sample|fixture|example)/

export async function route(request, operationRaw) {
  const operation = norm(operationRaw)

  if (operation === 'demo' && request.method === 'GET') return { body: demo() }

  if (['inspect', 'repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }

  // 工作台内置示例（GET，也允许 POST 取状态）。
  if (DEMO_ACTION.test(operation) && TOPIC.test(operation) &&
      (request.method === 'GET' || request.method === 'POST')) {
    return { body: workbenchDemo() }
  }
  if (['workbench-demo', 'bench-demo'].includes(operation) && request.method === 'GET') {
    return { body: workbenchDemo() }
  }

  if (request.method === 'POST') {
    const hasTopic = TOPIC.test(operation)
    const repairWord = REPAIR_ACTION.test(operation)
    const inspectWord = !repairWord && INSPECT_ACTION.test(operation)
    if (hasTopic || repairWord || inspectWord) {
      const input = await readJson(request, 1700000)
      const hasRegions = (Array.isArray(input.regions) && input.regions.length > 0) ||
        (Array.isArray(input.boxes) && input.boxes.length > 0)
      let doRepair
      if (repairWord) doRepair = true
      else if (inspectWord) doRepair = false
      else doRepair = input.repair === true || input.render === true || input.apply === true || hasRegions
      return { body: doRepair ? repairWorkbench(input) : inspectWorkbench(input) }
    }
  }

  if (request.method === 'GET' && TOPIC.test(operation) && !INSPECT_ACTION.test(operation)) {
    return { body: workbenchDemo() }
  }

  throw new InputError('找不到音频工作台入口。', 404)
}
