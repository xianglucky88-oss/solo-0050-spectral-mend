import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { bleedDemo } from './audio/bleed-demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { calibrate } from './bleed/session.mjs'

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (operation === 'bleed-demo' && request.method === 'GET') return { body: bleedDemo() }
  if (['inspect','repair','calibrate'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    if (operation === 'calibrate') return { body: calibrate(input) }
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
