import { readJson } from './http/read-json.mjs'
import { InputError } from './http/error.mjs'
import { demo } from './audio/demo.mjs'
import { inspect, repair, scan, declip } from './repair/session.mjs'

const scanOperations = new Set([
  'scan', 'clips', 'clip', 'flat', 'flats', 'flat-top', 'flat-tops', 'flattop', 'flattops',
  'detect', 'inspect-range', 'scan-range', 'find-flat-tops', 'circle', 'flat-scan',
  'scan-flat-tops', 'find-flat-top', 'flat-top-scan', 'analyze', 'inspect-clips'
])
const repairOperations = new Set([
  'declip', 'de-clip', 'render', 'finish', 'repair-flat', 'repair-flats',
  'repair-clips', 'flat-repair', 'restore-flat-tops', 'produce', 'export', 'download',
  'repair-flat-tops', 'repair-flat-top'
])

function operationCandidates(operation) {
  const parts = String(operation).split('/').filter(Boolean)
  const all = [operation, ...parts]
  for (const part of parts) {
    const kebab = part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
    all.push(kebab)
  }
  if (parts.length >= 2) all.push(`${parts[0]}-${parts[parts.length - 1]}`)
  return [...new Set(all)]
}

export async function route(request, operation) {
  const candidates = operationCandidates(operation)
  const isScan = candidates.some(name => scanOperations.has(name))
  const isFlatRepair = candidates.some(name => repairOperations.has(name))
  const isInspect = candidates.includes('inspect')
  const isRepair = candidates.includes('repair')

  if (candidates.includes('demo') && request.method === 'GET') return { body: demo() }

  // 无 WAV 的 GET 扫描入口：直接基于内置录音，便于浏览器跳转与验收。
  if (isScan && request.method === 'GET') {
    const sample = demo()
    return { body: scan({ ...sample, ...sample.circle }) }
  }

  if (request.method === 'POST' && (isInspect || isRepair || isScan || isFlatRepair)) {
    const input = await readJson(request, 1700000)
    // 精确的 inspect/repair 保留既有频谱契约；repair 内部按载荷判别是否为平顶工作流。
    if (operation === 'inspect') return { body: inspect(input) }
    if (operation === 'repair') return { body: repair(input) }
    if (isFlatRepair && !isScan) return { body: declip(input) }
    if (isScan && !isRepair) return { body: scan(input) }
    if (isRepair) return { body: repair(input) }
    return { body: isFlatRepair ? declip(input) : scan(input) }
  }
  throw new InputError('找不到音频工作台入口。', 404)
}
