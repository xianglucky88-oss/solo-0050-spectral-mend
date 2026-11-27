import { createServer } from 'node:http'
import { route } from './routes.mjs'
import { staticFile } from './http/static.mjs'
import { respond } from './http/respond.mjs'
import { InputError } from './http/error.mjs'

export function createApp() {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (pathname.startsWith('/api/spectral-mend/')) {
        respond(response, await route(request, pathname.slice('/api/spectral-mend/'.length)))
      } else if (pathname.startsWith('/api/')) {
        // 兼容 /api/workbench/inspect、/api/timeline/repair、/api/clip/... 等命名。
        const rest = pathname.slice('/api/'.length)
        const slash = rest.indexOf('/')
        const topic = slash === -1 ? rest : rest.slice(0, slash)
        const action = slash === -1 ? '' : rest.slice(slash + 1)
        const aliases = new Set(['workbench', 'bench', 'timeline', 'studio', 'arrange',
          'arrangement', 'compose', 'composition', 'splice', 'montage', 'sequence',
          'clips', 'clip', 'takes', 'take', 'segments', 'segment', 'pieces', 'piece',
          'occurrences', 'occurrence', 'appearances'])
        if (aliases.has(topic)) {
          respond(response, await route(request, action ? `${topic}-${action}` : topic))
        } else {
          throw new InputError('找不到音频工作台入口。', 404)
        }
      } else if (request.method === 'GET') {
        respond(response, await staticFile(pathname))
      } else {
        throw new InputError('此入口不接受该请求方法。', 405)
      }
    } catch (error) {
      if (!(error instanceof InputError)) console.error(error)
      respond(response, { status: error instanceof InputError ? error.status : 500,
        body: { error: error instanceof InputError ? error.message : '处理失败，请重试。' } })
    }
  })
}
