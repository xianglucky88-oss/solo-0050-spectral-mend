import { open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { InputError } from '../http/error.mjs'
import { MAX_UPLOAD_BYTES } from './limits.mjs'

// 将请求体流式落到临时文件，内存占用只等于单个网络块大小。
export async function receiveWav(request) {
  const mediaType = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
  if (mediaType !== 'audio/wav' && mediaType !== 'audio/wave' && mediaType !== 'audio/x-wav') {
    request.resume()
    throw new InputError('请求体需要使用 audio/wav 二进制 WAV。', 415)
  }
  const path = join(tmpdir(), `spectral-mend-${randomUUID()}.wav`)
  let handle, size = 0
  try {
    handle = await open(path, 'wx')
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) {
        request.resume()
        throw new InputError('音频文件超出五分钟 WAV 的大小限制。', 413)
      }
      await handle.write(chunk)
    }
    await handle.close()
    return { path, size }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(path, { force: true })
    throw error
  }
}

export async function removeWav(path) {
  await rm(path, { force: true })
}
