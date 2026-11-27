import { encode } from '../server/audio/encode.mjs'
import { decode } from '../server/audio/decode.mjs'
import { calibrate } from '../server/bleed/session.mjs'
import { bleedDemo } from '../server/audio/bleed-demo.mjs'

/**
 * 串漏校准的有界自检。构造已知串漏的合成录音，覆盖：成功还原、
 * 同频不同相位、缺证、校准不一致、歧义，以及校准区/圈外逐样保留。
 * 任何检查失败即以非零码退出。
 */
const rate = 16000
let failures = 0
const check = (name, condition, detail = '') => {
  if (!condition) { failures++; console.error(`FAIL ${name}${detail ? ' - ' + detail : ''}`) }
}

const taps = [0.15, -0.07, 0.04, 0.01, 0, -0.02, 0.01, 0]
const other = [0.12, 0.05, 0, -0.03, 0.02, 0, 0.01, 0]
const convolve = (history, n, h) => {
  let sum = 0
  for (let k = 1; k <= h.length; k++) if (n - k >= 0) sum += h[k - 1] * history[n - k]
  return sum
}

function synth({ frames = rate * 3, hLR = taps, hRL = other, leftSolo, rightSolo, program, left, right }) {
  const L = new Float64Array(frames), R = new Float64Array(frames)
  const sL = new Float64Array(frames), sR = new Float64Array(frames)
  for (let n = 0; n < frames; n++) {
    const inL = leftSolo.some(([a, b]) => n >= a && n < b) || (n >= program[0] && n < program[1])
    const inR = rightSolo.some(([a, b]) => n >= a && n < b) || (n >= program[0] && n < program[1])
    sL[n] = inL ? left(n) : 0
    sR[n] = inR ? right(n) : 0
  }
  for (let n = 0; n < frames; n++) {
    L[n] = sL[n] + convolve(sR, n, hRL)
    R[n] = sR[n] + convolve(sL, n, hLR)
  }
  const pick = segments => segments.map(([a, b]) => ({ startFrame: a, endFrame: b }))
  const wav = encode({ tracks: [L, R], rate, frames }).toString('base64')
  return { wav, truth: { sL, sR }, frames,
    input: { wav, calibration: { solos: [pick(leftSolo), pick(rightSolo)],
      program: { startFrame: program[0], endFrame: program[1] } } } }
}

const rms = (a, b, from, to) => {
  let sum = 0
  for (let n = from; n < to; n++) sum += (a[n] - b[n]) ** 2
  return Math.sqrt(sum / (to - from))
}

// 1) 内置示例可校准且成品属性一致。
{
  const sample = bleedDemo()
  const result = calibrate({ wav: sample.wav, calibration: sample.calibration })
  check('demo ok', result.status === 'ok', result.issues?.[0]?.message)
  check('demo restored', result.restored === true && typeof result.wav === 'string')
  if (result.status === 'ok') {
    const audio = decode(result.wav)
    check('demo preserves rate/frames/channels', audio.rate === 16000 && audio.tracks.length === 2)
    check('demo preserves outside program', result.preserved.calibrationAndOutsidePreserved)
  }
}

// 2) 深度串漏的成功还原。
{
  const frames = rate * 2
  const left = n => 0.3 * Math.sin(2 * Math.PI * 220 * n / rate) + 0.15 * Math.sin(2 * Math.PI * 660 * n / rate + 0.4)
  const right = n => 0.28 * Math.sin(2 * Math.PI * 330 * n / rate + 1.1) + 0.14 * Math.sin(2 * Math.PI * 990 * n / rate)
  const scene = synth({ frames,
    leftSolo: [[1000, 3000], [5000, 7000], [9000, 11000]],
    rightSolo: [[12000, 14000], [15000, 17000], [18000, 20000]],
    program: [21000, 30000], left, right })
  const result = calibrate(scene.input)
  check('separate ok', result.status === 'ok', result.issues?.[0]?.message)
  if (result.status === 'ok') {
    const audio = decode(result.wav)
    check('separate left recovered', rms(audio.tracks[0], scene.truth.sL, 21000, 30000) < 2e-3)
    check('separate right recovered', rms(audio.tracks[1], scene.truth.sR, 21000, 30000) < 2e-3)
  }
}

// 3) 缺证：每方向只有一段有声独奏。
{
  const frames = rate
  const L = new Float64Array(frames), R = new Float64Array(frames)
  for (let n = 1000; n < 3000; n++) L[n] = 0.35 * Math.sin(2 * Math.PI * 250 * n / rate)
  for (let n = 5000; n < 7000; n++) R[n] = 0.35 * Math.sin(2 * Math.PI * 350 * n / rate)
  for (let n = 9000; n < 11000; n++) { L[n] = 0.2 * Math.sin(2 * Math.PI * 250 * n / rate); R[n] = 0.2 * Math.sin(2 * Math.PI * 350 * n / rate) }
  const result = calibrate({ wav: encode({ tracks: [L, R], rate, frames }).toString('base64'),
    calibration: {
      solos: [[{ startFrame: 1000, endFrame: 3000 }], [{ startFrame: 5000, endFrame: 7000 }]],
      program: { startFrame: 9000, endFrame: 11000 } } })
  check('insufficient flagged', result.status === 'error' && result.wav === null &&
    result.issues.some(issue => issue.kind === 'insufficient-evidence'))
}

// 4) 校准不一致：每段串漏增益不同。
{
  const frames = rate
  const L = new Float64Array(frames), R = new Float64Array(frames)
  const segments = [[1000, 3000], [4000, 6000], [7000, 9000]]
  segments.forEach(([a, b], index) => {
    for (let n = a; n < b; n++) {
      L[n] = 0.35 * Math.sin(2 * Math.PI * (250 + index * 130) * n / rate)
      R[n] = [0.08, 0.32, 0.04][index] * L[n - 2]
    }
  })
  const rightSolo = [[10000, 11500], [12000, 13500], [14000, 15000]]
  rightSolo.forEach(([a, b], index) => {
    for (let n = a; n < b; n++) R[n] = 0.3 * Math.sin(2 * Math.PI * (420 + index * 60) * n / rate)
  })
  const result = calibrate({ wav: encode({ tracks: [L, R], rate, frames }).toString('base64'),
    calibration: {
      solos: [segments.map(([a, b]) => ({ startFrame: a, endFrame: b })),
        rightSolo.map(([a, b]) => ({ startFrame: a, endFrame: b }))],
      program: { startFrame: 15200, endFrame: 15800 } } })
  check('inconsistent flagged', result.status === 'error' && result.wav === null &&
    result.issues.some(issue => issue.kind === 'inconsistent-calibration'))
}

// 5) 歧义：中段独奏处两种关系预测相同，节目还原相差超过 64 码。
{
  const frames = rate * 4
  const f0 = 1000, w = 2 * Math.PI * f0 / rate
  const d = [1, -2 * Math.cos(w), 1], alpha = 0.05
  const hA = [0.20, 0, 0, 0, 0, 0, 0, 0]
  const hB = [0.20 + alpha * d[0], alpha * d[1], alpha * d[2], 0, 0, 0, 0, 0]
  const sL = new Float64Array(frames), sR = new Float64Array(frames)
  let seed = 7
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
  for (let n = 11500; n < 18500; n++) sL[n] = 0.4 * Math.sin(w * n)
  for (let n = 2000; n < 8000; n++) sL[n] = 0.3 * noise()
  for (let n = 22000; n < 28000; n++) sL[n] = 0.3 * noise()
  for (const [a, b] of [[30000, 35000], [38000, 43000], [46000, 51000]]) for (let n = a; n < b; n++) sR[n] = 0.3 * noise()
  for (let n = 53000; n < 63000; n++) { sL[n] = 0.3 * noise(); sR[n] = 0.3 * noise() }
  const L = new Float64Array(frames), R = new Float64Array(frames)
  for (let n = 0; n < frames; n++) {
    let bleedLR = 0
    if (n >= 2000 && n < 8000) bleedLR = convolve(sL, n, hA)
    else if (n >= 12000 && n < 28000) bleedLR = convolve(sL, n, hB)
    else bleedLR = convolve(sL, n, hA)
    R[n] = sR[n] + bleedLR
    L[n] = sL[n] + convolve(sR, n, other)
  }
  const pick = segments => segments.map(([a, b]) => ({ startFrame: a, endFrame: b }))
  const result = calibrate({ wav: encode({ tracks: [L, R], rate, frames }).toString('base64'),
    calibration: {
      solos: [pick([[2000, 8000], [12000, 18000], [22000, 28000]]), pick([[30000, 35000], [38000, 43000], [46000, 51000]])],
      program: { startFrame: 53000, endFrame: 63000 } } })
  check('ambiguous flagged', result.status === 'error' && result.wav === null &&
    result.issues.some(issue => issue.kind === 'ambiguous'))
  const flagged = result.issues.find(issue => issue.kind === 'ambiguous')
  check('ambiguous names direction', flagged && ['L→R', 'R→L'].includes(flagged.direction))
  check('ambiguous exceeds 64 codes', result.directions[flagged.direction].maxExplanationDifference > 64)
}

if (failures) { console.error(`\n${failures} 项自检失败`); process.exit(1) }
console.log('串漏校准自检通过')
