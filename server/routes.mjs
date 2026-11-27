import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair, trace } from './repair/session.mjs'

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (['inspect','repair','trace'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    const handlers = { inspect, repair, trace }
    return { body: handlers[operation](input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
