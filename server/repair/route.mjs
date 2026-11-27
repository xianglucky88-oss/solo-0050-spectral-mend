import { InputError } from '../http/error.mjs'

// A trace is defined by a time/frequency range plus hum location points. The
// points are physical anchors (seconds, hertz); the route between them is a
// straight line in the time/frequency plane, so a device hum that climbs at a
// steady rate is followed window by window.
export function validateRange(range, audio, plan) {
  const duration = audio.frames / audio.rate
  const { start, end, low, high } = range ?? {}
  if (![start, end, low, high].every(Number.isFinite) || start < 0 || end <= start ||
      end > duration || low < 0 || high <= low || high > audio.rate / 2) {
    throw new InputError('嗡声时段需要有效的起止时间与频带。')
  }
  if ((end - start) * audio.rate < plan.size) throw new InputError('嗡声时段至少要容纳一个分析窗。')
  return { start, end, low, high }
}

export function validatePoints(points, range) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 32) {
    throw new InputError('请在交会前后各点一次嗡声，共需 2–32 个定位点。')
  }
  const clean = points.map(point => {
    const { time, frequency } = point ?? {}
    if (!Number.isFinite(time) || !Number.isFinite(frequency) || time < range.start ||
        time > range.end || frequency < range.low || frequency > range.high) {
      throw new InputError('定位点需要落在圈定的时段与频带内。')
    }
    return { time, frequency }
  }).sort((a, b) => a.time - b.time)
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].time - clean[i - 1].time < 1e-4) throw new InputError('定位点的时间需要彼此分开。')
  }
  return clean
}

export function validateDepth(value) {
  if (!Number.isFinite(value) || value < 6 || value > 60) {
    throw new InputError('嗡声衰减需要在 6–60 dB 之间。')
  }
  return value
}

export function expectedFrequency(points, time) {
  const first = points[0], last = points[points.length - 1]
  if (time <= first.time) return first.frequency
  if (time >= last.time) return last.frequency
  for (let i = 1; i < points.length; i++) {
    if (time <= points[i].time) {
      const before = points[i - 1], after = points[i]
      return before.frequency + (after.frequency - before.frequency) *
        (time - before.time) / (after.time - before.time)
    }
  }
  return last.frequency
}
