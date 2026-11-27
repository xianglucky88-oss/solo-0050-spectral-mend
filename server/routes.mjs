import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { roomExport, roomProof } from './room/session.mjs'

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (['inspect','repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  if (['room-export','room-proof'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 6000000)
    return { body: operation === 'room-export' ? roomExport(input) : roomProof(input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
