import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { glideDemo } from './glide/demo.mjs'
import { glideInspect, glide } from './glide/session.mjs'

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (operation === 'glide-demo' && request.method === 'GET') return { body: glideDemo() }
  if (['inspect','repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  if (['glide-inspect','glide'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'glide-inspect' ? glideInspect(input) : glide(input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
