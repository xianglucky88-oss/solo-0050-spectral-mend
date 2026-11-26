// 上滑音工作流的有界生产检查：辨识、合成、4Hz 间隔规则、硬拒绝与格式保持。
import { glideDemo } from '../server/glide/demo.mjs'
import { glideInspect, glide } from '../server/glide/session.mjs'
import { parseGlideParams } from '../server/glide/params.mjs'
import { analyze } from '../server/glide/analyze.mjs'
import { synthesize } from '../server/glide/synthesize.mjs'
import { encode } from '../server/audio/encode.mjs'
import { decode } from '../server/audio/decode.mjs'
import { localCoefficient, magnitude } from '../server/glide/dft.mjs'

let failures = 0
const check = (label, condition, detail = '') => {
  if (!condition) { failures++; console.error(`FAIL ${label} ${detail}`) }
  else console.log(`ok   ${label}`)
}

// 1. 内置演示：辨识成功且生成无饱和的上滑音。
const demo = glideDemo()
const inspection = glideInspect({ wav: demo.wav, ...demo.params })
check('demo inspection identifies f0', inspection.ok, inspection.reason ?? '')
const applied = glide({ wav: demo.wav, size: 512, ...demo.params })
check('demo glide produces changed PCM', applied.ok && applied.changed)
check('demo output has no saturation', applied.metrics.every(channel => channel.saturation === 0))

// 2. 格式保持与圈外逐样保留（浮点层）。
{
  const audio = decode(demo.wav)
  const params = parseGlideParams(demo.params, audio)
  const analysis = analyze(audio, params)
  const edited = synthesize(audio, params, analysis)
  const first = Math.round(params.start * audio.rate), last = Math.round(params.end * audio.rate)
  let outsideMismatch = 0
  for (let c = 0; c < audio.tracks.length; c++) {
    for (let i = 0; i < audio.frames; i++) {
      if ((i < first || i >= last) && edited.tracks[c][i] !== audio.tracks[c][i]) outsideMismatch++
    }
  }
  check('outside-segment samples preserved exactly', outsideMismatch === 0)
  check('segment-edge sample untouched (fade weight 0)', edited.tracks[0][first] === audio.tracks[0][first])
  const reEncoded = decode(encode(edited).toString('base64'))
  check('rate/channels/frames preserved',
    reEncoded.rate === audio.rate && reEncoded.frames === audio.frames &&
    reEncoded.tracks.length === audio.tracks.length)
}

// 3. 基频匀速上滑、各阶随基频变化。
{
  const rate = 16000, frames = rate * 2
  const tracks = [Float64Array.from({ length: frames }, (_, i) => {
    const t = i / rate
    return 0.3 * Math.sin(2 * Math.PI * 200 * t) + 0.2 * Math.sin(2 * Math.PI * 400 * t) + 0.1 * Math.sin(2 * Math.PI * 600 * t)
  })]
  const audio = { tracks, rate, frames }
  const params = parseGlideParams(
    { start: 0.3, end: 1.5, low: 150, high: 250, orders: [1, 2, 3], sidebands: [15, 15, 15], targetStart: 200, targetEnd: 300 }, audio)
  const edited = synthesize(audio, params, analyze(audio, params))
  const peak = (t, lo, hi) => {
    let best = { f: 0, m: -1 }
    for (let f = lo; f <= hi; f += 0.5) {
      const m = magnitude(localCoefficient(edited.tracks[0], t, 4096, 1024, rate, f))
      if (m > best.m) best = { f, m }
    }
    return best.f
  }
  const t = 1.0, f0 = 200 + 100 * (t - 0.3) / 1.2
  check('fundamental follows linear glide', Math.abs(peak(t, f0 - 25, f0 + 25) - f0) < 3)
  check('second harmonic tracks 2*f0', Math.abs(peak(t, 2 * f0 - 30, 2 * f0 + 30) - 2 * f0) < 4)
  check('third harmonic tracks 3*f0', Math.abs(peak(t, 3 * f0 - 35, 3 * f0 + 35) - 3 * f0) < 5)
}

// 4. 硬拒绝：短于 40ms、触及 0 或奈奎斯特。
check('segment shorter than 40ms rejected',
  glide({ wav: demo.wav, ...demo.params, start: 1.0, end: 1.02 }).ok === false)
check('target band touching nyquist rejected',
  glide({ wav: demo.wav, ...demo.params, targetEnd: 7900 }).ok === false)
check('rejection returns byte-identical original',
  glide({ wav: demo.wav, ...demo.params, start: 1.0, end: 1.02 }).wav === demo.wav)

// 5. 4Hz 独占间隔规则。
{
  const rate = 16000, frames = rate * 2
  const tone = extra => Float64Array.from({ length: frames }, (_, i) =>
    0.4 * Math.sin(2 * Math.PI * 300 * i / rate) + extra(i))
  const base = { start: 0.3, end: 1.5, low: 250, high: 350, orders: [1], targetStart: 300, targetEnd: 310 }
  const wavOf = track => encode({ tracks: [track], rate, frames }).toString('base64')
  // 旁音 330Hz，边带 27Hz 时声明到 327，与 330 隔 3Hz -> 拒绝；边带 20Hz 隔 10Hz -> 通过。
  const near330 = tone(i => 0.15 * Math.sin(2 * Math.PI * 330 * i / rate))
  check('companion 3Hz inside guard band rejected',
    glideInspect({ wav: wavOf(near330), ...base, sidebands: [27] }).ok === false)
  check('companion 10Hz away accepted',
    glideInspect({ wav: wavOf(near330), ...base, sidebands: [20] }).ok === true)
  // 可分辨（5Hz）旁音 305Hz，配 2Hz 边带时距带边缘仅 3Hz -> 拒绝。
  const near305 = tone(i => 0.1 * Math.sin(2 * Math.PI * 305 * i / rate))
  check('resolvable companion violating 4Hz edge rejected',
    glideInspect({ wav: wavOf(near305), ...base, sidebands: [2] }).ok === false)
  // 边带 1Hz 时 305 距带边缘正好 4Hz -> 通过。
  check('companion at exactly 4Hz edge accepted',
    glideInspect({ wav: wavOf(near305), ...base, sidebands: [1] }).ok === true)
}

if (failures) { console.error(`\n${failures} 个检查未通过。`); process.exit(1) }
console.log('\n上滑音工作流检查全部通过。')
