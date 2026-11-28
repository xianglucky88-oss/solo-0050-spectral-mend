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
        const result = await route(request, pathname.slice('/api/spectral-mend/'.length), response)
        if (!result?.streamed) respond(response, result)
      } else if (request.method === 'GET') {
        respond(response, await staticFile(pathname))
      } else {
        throw new InputError('此入口不接受该请求方法。', 405)
      }
    } catch (error) {
      if (!(error instanceof InputError)) console.error(error)
      if (response.headersSent) {
        response.destroy()
        return
      }
      respond(response, { status: error instanceof InputError ? error.status : 500,
        body: { error: error instanceof InputError ? error.message : '处理失败，请重试。' } })
    }
  })
}
