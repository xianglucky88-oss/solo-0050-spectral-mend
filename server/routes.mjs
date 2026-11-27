import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { lockDemo, lockInspect, lockMove } from './lock/session.mjs'

export async function route(request, operation) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }

  // 落锁对轨：内置样本、生成前辨认/预览、生成搬迁。
  if (['lock-demo', 'locks-demo'].includes(operation) && request.method === 'GET') return { body: lockDemo() }
  if (['lock-inspect', 'lock-detect', 'lock-preview', 'locks-inspect'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: lockInspect(input) }
  }
  if (['lock-move', 'lock', 'lock-apply', 'lock-render', 'lock-relocate', 'relocate', 'locks-move'].includes(operation)
      && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: lockMove(input) }
  }

  if (['inspect','repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 1700000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}

// 独立前缀 /api/lock/* 与 /api/lock-move/* 的路由，便于按资源风格调用。
export async function lockRoute(request, operation) {
  const op = (operation || '').replace(/^\/+|\/+$/g, '')
  if ((op === 'demo' || op === 'lock-demo') && request.method === 'GET') return { body: lockDemo() }
  if (['inspect', 'detect', 'preview', 'check'].includes(op) && request.method === 'POST') {
    return { body: lockInspect(await readJson(request, 1700000)) }
  }
  if (['', 'move', 'apply', 'render', 'relocate'].includes(op) && request.method === 'POST') {
    return { body: lockMove(await readJson(request, 1700000)) }
  }
  throw new InputError('找不到落锁对轨入口。可用 demo / inspect / move。', 404)
}
