import { randomUUID } from 'node:crypto'
import { removeWav } from '../audio/receive.mjs'

// 只保存临时文件句柄路径与格式元数据，音频字节留在磁盘，会话表不随录音变大。
const sessions = new Map()
const TTL_MS = 30 * 60 * 1000

export function createSession(entry) {
  const token = randomUUID()
  sessions.set(token, { ...entry, openedAt: Date.now() })
  return token
}

export function getSession(token) {
  const session = sessions.get(token)
  if (!session) return null
  if (Date.now() - session.openedAt > TTL_MS) {
    closeSession(token)
    return null
  }
  return session
}

export function closeSession(token) {
  const session = sessions.get(token)
  if (!session) return
  sessions.delete(token)
  removeWav(session.path).catch(() => {})
}

// 周期性淘汰过期会话，避免临时文件堆积；缓存条目数本身受活跃会话数限制。
const timer = setInterval(() => {
  for (const [token, session] of sessions) {
    if (Date.now() - session.openedAt > TTL_MS) closeSession(token)
  }
}, 60_000)
timer.unref?.()
