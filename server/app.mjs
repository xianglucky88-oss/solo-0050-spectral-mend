import { createServer } from 'node:http'
import { route } from './routes.mjs'
import { staticFile } from './http/static.mjs'
import { respond } from './http/respond.mjs'
import { InputError } from './http/error.mjs'

export function createApp() {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const apiPrefixes = [
        '/api/spectral-mend/',
        '/api/flat-top/',
        '/api/flattop/',
        '/api/flattops/',
        '/api/clips/',
        '/api/declip/'
      ]
      const prefix = apiPrefixes.find(candidate => pathname.startsWith(candidate))
      const exactApi = new Map([
        ['/api/clips', 'clips'],
        ['/api/clip', 'clips'],
        ['/api/flattops', 'flattops'],
        ['/api/flat-tops', 'flat-tops'],
        ['/api/flat-top', 'flat-top'],
        ['/api/flats', 'flats'],
        ['/api/declip', 'declip'],
        ['/api/render', 'render']
      ])
      if (prefix) {
        respond(response, await route(request, pathname.slice(prefix.length)))
      } else if (exactApi.has(pathname)) {
        respond(response, await route(request, exactApi.get(pathname)))
      } else if (pathname.startsWith('/api/') && pathname === '/api/spectral-mend') {
        respond(response, await route(request, 'demo'))
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
