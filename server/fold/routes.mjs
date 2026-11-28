import { readJson } from '../http/read-json.mjs'
import { InputError } from '../http/error.mjs'
import { demo } from './demo.mjs'
import { inspect, fold, rescue } from './session.mjs'

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (['inspect', 'fold', 'rescue'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: { inspect, fold, rescue }[operation](input) }
  }
  throw new InputError('找不到单喇叭交付工作台入口。', 404)
}
