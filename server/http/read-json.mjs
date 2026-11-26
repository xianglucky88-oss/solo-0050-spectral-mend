import { InputError } from './error.mjs'

export async function readJson(request, limit) {
  const mediaType = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    request.resume()
    throw new InputError('请求体需要使用 JSON。', 415)
  }
  const chunks = []
  let remaining = limit
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    remaining -= chunk.length
    if (remaining < 0) {
      request.resume()
      throw new InputError('输入超出大小限制。', 413)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new InputError('无法读取 JSON。')
  }
}
