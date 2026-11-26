import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { InputError } from './error.mjs'

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8']
])

export async function staticFile(pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1)
  const type = types.get(extname(name))
  if (!type || !/^[a-z0-9/_-]+\.[a-z]+$/.test(name)) throw new InputError('找不到页面。', 404)
  try {
    return { type, body: await readFile(new URL(`../../public/${name}`, import.meta.url)) }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new InputError('找不到页面。', 404)
    throw error
  }
}
