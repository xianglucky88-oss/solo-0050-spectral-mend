import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { handoffPrepare, handoffCommit, handoffReopen, handoffCopy } from './handoff/session.mjs'

const handoffOperations = new Map([
  ['handoff-prepare', handoffPrepare],
  ['handoff-commit', handoffCommit],
  ['handoff-reopen', handoffReopen],
  ['handoff-copy', handoffCopy],
])

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (['inspect','repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  if (handoffOperations.has(operation) && request.method === 'POST') {
    const input = await readJson(request, 4000000)
    return { body: handoffOperations.get(operation)(input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
