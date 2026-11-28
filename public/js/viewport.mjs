import { MAX_AUDITION_SECONDS } from './limits.mjs'

// 视区以原始录音的秒坐标表示 { start, end }，与谱图如何聚合无关。
// 平移/缩放只改变这个区间，选区仍用原始时频坐标存储，因此换视图后选区落在原位。
export function createViewport(duration) {
  let start = 0, end = duration
  const listeners = []
  const view = () => ({ start, end })
  const emit = () => listeners.forEach(fn => fn(view()))
  const clamp = (a, b) => {
    const width = b - a
    if (width >= duration) return { start: 0, end: duration }
    if (a < 0) return { start: 0, end: width }
    if (b > duration) return { start: duration - width, end: duration }
    return { start: a, end: b }
  }
  return {
    view,
    duration,
    onChange(fn) { listeners.push(fn) },
    zoom(factor, center) {
      const at = Number.isFinite(center) ? Math.max(start, Math.min(end, center)) : (start + end) / 2
      const width = Math.max(0.1, Math.min(duration, (end - start) * factor))
      const ratio = (at - start) / (end - start)
      ;({ start, end } = clamp(at - ratio * width, at + (1 - ratio) * width))
      emit()
    },
    pan(ratio) {
      const width = end - start
      ;({ start, end } = clamp(start + ratio * width, end + ratio * width))
      emit()
    },
    jumpTo(time) {
      const width = end - start
      const centered = Math.max(0, Math.min(duration - width, time - width / 2))
      ;({ start, end } = clamp(centered, centered + width))
      emit()
    },
    reset() {
      start = 0; end = duration
      emit()
    },
    // 试听区间：以视区左缘为起点，长度不超过十秒且不越过录音结尾。
    auditionRange() {
      const stop = Math.min(duration, start + MAX_AUDITION_SECONDS)
      return { start, end: stop }
    }
  }
}
