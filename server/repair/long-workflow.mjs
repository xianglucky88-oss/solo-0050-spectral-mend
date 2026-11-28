import { open } from 'node:fs/promises'
import { scanWav } from '../audio/scan.mjs'
import { envelope } from '../audio/envelope.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { viewColumns } from '../spectrum/view.mjs'
import { streamRepair } from './stream-rebuild.mjs'
import { createWavWriter, bufferSink } from '../audio/wav-writer.mjs'
import { createSession, getSession } from './sessions.mjs'
import { SHORT_SECONDS, MAX_AUDITION_SECONDS } from '../audio/limits.mjs'
import { parseSize, parseRegions, parseRange, assertAuditionLimit } from './params.mjs'
import { InputError } from '../http/error.mjs'
import { repair as legacyRepair } from './session.mjs'

export async function openWav({ path, size }) {
  let handle
  try {
    handle = await open(path, 'r')
    const info = await scanWav(handle, size)
    await handle.close()
    if (!info.complete) {
      return { complete: false, reason: '数据截在采样帧中间，文件不完整，已拒绝生成。',
        rate: info.rate, channels: info.channels, frames: info.frames }
    }
    const token = createSession({ path, size, rate: info.rate, channels: info.channels,
      align: info.align, frames: info.frames, dataOffset: info.dataOffset, complete: true })
    const handle2 = await open(path, 'r')
    let levels = []
    try {
      levels = await envelope(handle2, info)
    } finally {
      await handle2.close()
    }
    return { complete: true, token, rate: info.rate, channels: info.channels, frames: info.frames,
      duration: info.frames / info.rate, longMode: info.frames > SHORT_SECONDS * info.rate,
      envelope: levels }
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function loadSession(token) {
  const session = getSession(token)
  if (!session) throw new InputError('会话已过期，请重新打开录音。', 404)
  return session
}

export async function spectrumView(token, query) {
  const session = loadSession(token)
  const size = parseSize(query.size)
  const plan = windowPlan(session.frames, size)
  const handle = await open(session.path, 'r')
  try {
    const spectrum = await viewColumns(handle, session, plan, Number(query.viewStart), Number(query.viewEnd))
    return { rate: session.rate, frames: session.frames, channels: session.channels, size, spectrum }
  } finally {
    await handle.close()
  }
}

// 试听扇区：原声与修复声使用相同的帧区间、同一窗表与同一增益。
export async function auditionSegment(token, query) {
  const session = loadSession(token)
  const size = parseSize(query.size)
  const regionList = parseRegions(query.regions, session)
  const range = parseRange({ start: query.start, end: query.end }, session, MAX_AUDITION_SECONDS)
  assertAuditionLimit(range)
  const plan = windowPlan(session.frames, size)
  const first = Math.round(range.start * session.rate)
  const last = Math.min(session.frames, Math.round(range.end * session.rate))
  const handle = await open(session.path, 'r')
  try {
    const repaired = bufferSink()
    const writer = createWavWriter(repaired, { ...session, frames: last - first })
    const result = await streamRepair(handle, session, plan, regionList,
      samples => writer.writeFrame(samples), first, last)
    const { bytes } = await writer.finish()
    return {
      start: range.start, end: last / session.rate, frames: last - first,
      editedWindows: result.editedWindows,
      original: await originalSegment(handle, session, first, last),
      repaired: repaired.buffer().subarray(0, bytes).toString('base64')
    }
  } finally {
    await handle.close()
  }
}

async function originalSegment(handle, info, first, last) {
  const { readFrames } = await import('../audio/scan.mjs')
  const block = await readFrames(handle, info, first, last - first)
  const sink = bufferSink()
  const writer = createWavWriter(sink, { ...info, frames: block.count })
  const samples = new Int16Array(info.channels)
  for (let i = 0; i < block.count; i++) {
    for (let c = 0; c < info.channels; c++) {
      samples[c] = Math.max(-32768, Math.min(32767, Math.round(block.tracks[c][i] * 32768)))
    }
    writer.writeFrame(samples)
  }
  const { bytes } = await writer.finish()
  return sink.buffer().subarray(0, bytes).toString('base64')
}

// 整件生成。六秒内录音走旧版 repair，保证与旧入口逐样一致；
// 更长的录音流式重建并直接写入响应，服务端工作内存与总帧数无关。
export async function generateWav(token, query, response) {
  const session = loadSession(token)
  const size = parseSize(query.size)
  const regionList = parseRegions(query.regions, session)
  if (!session.complete) throw new InputError('文件不完整，拒绝生成。')
  const short = session.frames <= SHORT_SECONDS * session.rate
  if (short) {
    const { encode } = await import('../audio/encode.mjs')
    const tracks = await loadTracks(session)
    const wavInput = { rate: session.rate, frames: session.frames, tracks }
    const legacy = legacyRepair({ wav: encode(wavInput).toString('base64'), size, regions: regionList })
    const bytes = Buffer.from(legacy.wav, 'base64')
    response.writeHead(200, {
      'content-type': 'audio/wav', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment; filename="restored-take.wav"'
    })
    response.end(bytes)
    return { legacy }
  }
  const plan = windowPlan(session.frames, size)
  const handle = await open(session.path, 'r')
  response.writeHead(200, {
    'content-type': 'audio/wav', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'attachment; filename="restored-take.wav"'
  })
  try {
    const writer = createWavWriter(response, session)
    const result = await streamRepair(handle, session, plan, regionList, samples => writer.writeFrame(samples))
    await writer.finish()
    return { editedWindows: result.editedWindows }
  } finally {
    await handle.close()
  }
}

async function loadTracks(session) {
  const handle = await open(session.path, 'r')
  try {
    const { readFrames } = await import('../audio/scan.mjs')
    const block = await readFrames(handle, session, 0, session.frames)
    return block.tracks
  } finally {
    await handle.close()
  }
}
