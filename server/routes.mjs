import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair } from './repair/session.mjs'
import { receiveWav, removeWav } from './audio/receive.mjs'
import { openWav, spectrumView, auditionSegment, generateWav } from './repair/long-workflow.mjs'

export async function route(request, operation, response) {
  if (operation === 'demo' && request.method === 'GET') return { body: demo() }
  if (['inspect', 'repair'].includes(operation) && request.method === 'POST') {
    const input = await readJson(request, 2_500_000)
    return { body: operation === 'inspect' ? inspect(input) : repair(input) }
  }
  if (operation === 'open' && request.method === 'POST') {
    const received = await receiveWav(request)
    try {
      const opened = await openWav(received)
      // 不完整文件不建立会话，立即清理临时文件。
      if (!opened.complete) await removeWav(received.path)
      return { body: opened }
    } catch (error) {
      await removeWav(received.path)
      throw error
    }
  }
  if (operation === 'view' && request.method === 'GET') {
    const { searchParams } = new URL(request.url, 'http://localhost')
    const query = Object.fromEntries(searchParams)
    return { body: await spectrumView(searchParams.get('token'), query) }
  }
  if (operation === 'audition' && request.method === 'GET') {
    const { searchParams } = new URL(request.url, 'http://localhost')
    const query = Object.fromEntries(searchParams)
    return { body: await auditionSegment(searchParams.get('token'), query) }
  }
  if (operation === 'generate' && request.method === 'GET') {
    const { searchParams } = new URL(request.url, 'http://localhost')
    const query = Object.fromEntries(searchParams)
    const info = await generateWav(searchParams.get('token'), query, response)
    return { streamed: true, legacy: info.legacy }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
