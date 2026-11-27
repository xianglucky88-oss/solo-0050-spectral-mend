import { createServer } from 'node:http'
import { route, lockRoute } from './routes.mjs'
import { staticFile } from './http/static.mjs'
import { respond } from './http/respond.mjs'
import { InputError } from './http/error.mjs'

export function createApp() {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      if (pathname.startsWith('/api/spectral-mend/')) {
        respond(response, await route(request, pathname.slice('/api/spectral-mend/'.length)))
      } else if (pathname === '/api/lock' || pathname === '/api/lock-move') {
        respond(response, await lockRoute(request, 'move'))
      } else if (pathname.startsWith('/api/lock/')) {
        respond(response, await lockRoute(request, pathname.slice('/api/lock/'.length)))
      } else if (pathname.startsWith('/api/lock-move/')) {
        respond(response, await lockRoute(request, pathname.slice('/api/lock-move/'.length)))
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
