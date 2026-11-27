// 落锁对轨的内置样本：稳态电机声（多声线、渐响渐弱、左右幅度/相位差）
// 中混入两次同步但左右强弱不同的落锁撞击。所有关键帧都是零起算整数，
// 便于页面预填与自检逐码核对。
import { encodePcm16Wav } from '../audio/pcm16.mjs'

export const LOCK_DEMO = {
  rate: 16000,
  frames: 64000, // 4.0 s
  segment: { start: 4000, end: 60000 },
  sources: [14000, 33000],
  targets: [20000, 42000],
  searches: [ { start: 13550, end: 14450 }, { start: 32550, end: 33450 } ],
  // 几何合法但落在段尾渐弱区的目标，用于演示“接声无解，请调整目标”。
  fadeTarget: 59950,
  // 一次圈住两个撞击的搜索范围，用于演示“找不到唯一撞击，请重圈”。
  ambiguousSearch: { start: 13550, end: 33450 },
  motor: { frequencies: [174, 261, 392], leftGain: 1.0, rightGain: 0.78, rightPhase: 0.62 }
}

function smooth(x) { return x * x * (3 - 2 * x) }

function motorEnvelope(time, duration) {
  const fadeIn = 0.55, fadeOutStart = duration - 0.85
  let g = 1
  if (time < fadeIn) g = smooth(Math.max(0, time / fadeIn))
  else if (time > fadeOutStart) g = smooth(Math.max(0, (duration - time) / (duration - fadeOutStart)))
  return g
}

// 确定性伪噪声，避免内置样本每次不同。
function noiseAt(i) {
  let x = (i * 1103515245 + 12345) & 0x7fffffff
  x = (x * 1103515245 + 12345) & 0x7fffffff
  return ((x >>> 8) % 2001) / 1000 - 1
}

function addClack(channels, frame, gains) {
  for (let c = 0; c < 2; c++) {
    const g = gains[c]
    // 主撞击：第 frame 帧即峰值，保证辨认帧就是零起算的植入帧。
    channels[c][frame] += Math.round(23500 * g)
    for (let k = 0; k < 32; k++) {
      const decay = Math.exp(-k / 6.5)
      const click = (noiseAt(frame + k + c * 977) * 0.55
        + 0.45 * Math.sin(2 * Math.PI * 1900 * k / 16000)) * decay
      channels[c][frame + k] += Math.round(9000 * g * click)
    }
  }
}

export function buildLockDemoPcm() {
  const { rate, frames, motor } = LOCK_DEMO
  const duration = frames / rate
  const pcm = [new Array(frames).fill(0), new Array(frames).fill(0)]
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const env = motorEnvelope(t, duration)
    let left = 0, right = 0
    motor.frequencies.forEach((hz, k) => {
      const amp = [0.17, 0.115, 0.07][k]
      const phase = 0.4 * k
      left += amp * Math.sin(2 * Math.PI * hz * t + phase)
      right += amp * motor.rightGain * Math.sin(2 * Math.PI * hz * t + phase + motor.rightPhase)
    })
    // 轻微的电机运转起伏（慢），不改变稳态频率；幅度远小于 5% 包络容差。
    const rumble = 1 + 0.02 * Math.sin(2 * Math.PI * 7 * t)
    pcm[0][i] = Math.round(left * env * rumble * motor.leftGain * 32767)
    pcm[1][i] = Math.round(right * env * rumble * 32767)
  }
  addClack(pcm, LOCK_DEMO.sources[0], [1.0, 0.62])
  addClack(pcm, LOCK_DEMO.sources[1], [0.85, 1.0])
  return pcm
}

export function lockDemo() {
  const pcm = buildLockDemoPcm()
  const wav = encodePcm16Wav({ pcm, rate: LOCK_DEMO.rate }).toString('base64')
  return {
    wav,
    rate: LOCK_DEMO.rate,
    frames: LOCK_DEMO.frames,
    channels: 2,
    zeroBased: true,
    blockFrames: 32,
    segment: LOCK_DEMO.segment,
    locks: LOCK_DEMO.sources.map((s, i) => ({
      search: LOCK_DEMO.searches[i],
      sourceFrame: s,
      targetFrame: LOCK_DEMO.targets[i]
    })),
    sourceFrames: LOCK_DEMO.sources,
    targetFrames: LOCK_DEMO.targets,
    presets: {
      ambiguousSearch: LOCK_DEMO.ambiguousSearch,
      motorOnlySearch: { start: 22000, end: 24000 },
      fadeTarget: LOCK_DEMO.fadeTarget
    }
  }
}
