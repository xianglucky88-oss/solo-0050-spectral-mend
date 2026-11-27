// 机器声参考消声工作流的有界自检：校准门限、<1ms 对听、<1/4 残声、
// 校准段/圈外/未覆盖逐码保留，以及静音/不唯一/无法达标拒绝。
// 运行：node scripts/verify-machine.mjs
import { machineDemo, makeMachinePair } from '../server/audio/machine-demo.mjs'
import { calibrate, cancelMachine } from '../server/machine/api.mjs'
import { fitCalibration } from '../server/machine/calibrate.mjs'
import { decode } from '../server/audio/decode.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name} ${detail}`)
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

// 1) Base64 全链路：校准共同达标
const demo = machineDemo()
const cal = calibrate({ wav: demo.mainWav, referenceWav: demo.referenceWav, first: demo.first, second: demo.second })
check('校准被接受', cal.accepted === true)
let allWithin = true
for (const seg of cal.segments) for (const ch of seg.channels) {
  if (!(ch.rmse <= ch.limit + 1e-12)) allWithin = false
}
check('各段各路 RMSE ≤ 5% 电平 + 1 码', allWithin)
check('同次响动偏差 < 1ms（或无离散响动时由波形拟合确认）',
  cal.events.vacant || cal.events.maxErrorMs < 1, `max=${cal.events.maxErrorMs}`)

// 2) 消声成品：格式保持、稳段 <1/4、原样区逐码一致
const out = cancelMachine({
  wav: demo.mainWav, referenceWav: demo.referenceWav,
  rho: cal.rho, delta: cal.delta, gains: cal.gains,
  first: demo.first, second: demo.second, repairs: demo.repairs,
  stable: demo.stable
})
check('成品保持原采样率/声道/帧数', out.rate === 16000 && out.channels === 2 && out.frames === 80000)
const stablePass = out.stable.every(block => block.channels.every(ch => ch.ratio < 0.25))
check('稳段残余机器声 RMS 低于修前 1/4', stablePass,
  out.stable.flatMap(b => b.channels.map(c => c.ratio.toFixed(3))).join(','))

const src = decode(demo.mainWav), dst = decode(out.wav)
const inside = (n, r) => n >= Math.round(r.start * 16000) && n < Math.round(r.end * 16000)
let calChanged = 0, outsideChanged = 0
for (let c = 0; c < 2; c++) for (let n = 0; n < src.frames; n++) {
  const a = Math.round(src.tracks[c][n] * 32768), b = Math.round(dst.tracks[c][n] * 32768)
  if (a === b) continue
  if (inside(n, demo.first) || inside(n, demo.second)) calChanged++
  if (!demo.repairs.some(r => inside(n, r))) outsideChanged++
}
check('校准段逐码原样', calChanged === 0, `changed=${calChanged}`)
check('修复区圈外逐码原样', outsideChanged === 0, `changed=${outsideChanged}`)

const uncovered = cancelMachine({
  wav: demo.mainWav, referenceWav: demo.referenceWav, calibration: cal,
  repairs: [{ start: 4.96, end: 5.0 }]
})
check('参考未覆盖处不处理', uncovered.processedFrames === 0)
const bypass = cancelMachine({ wav: demo.mainWav, referenceWav: demo.referenceWav, calibration: cal, repairs: [] })
check('无修复区时 WAV 与原件同 Base64', bypass.wav === demo.mainWav)

// 3) 拒绝情形
function rejected(label, mutate, expectedReason) {
  const pair = makeMachinePair()
  mutate?.(pair)
  try {
    fitCalibration({ main: pair.main, reference: pair.reference, first: pair.first, second: pair.second })
    check(label, false, '未拒绝')
  } catch (error) {
    check(label, error.code === 'calibration_rejected' && (!expectedReason || error.details?.reason === expectedReason),
      error.details?.reason ?? error.message)
  }
}
rejected('静音校准段拒绝', pair => {
  for (const t of pair.main.tracks) t.fill(0, 4000, 16800)
}, 'silence')
rejected('不相关参考拒绝（无法对应）', pair => {
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1 }
  const r = pair.reference.tracks[0]
  for (let i = 0; i < r.length; i++) r[i] = 0.3 * rnd()
})
rejected('两段比例不一致拒绝共同达标', pair => {
  for (const t of pair.main.tracks) for (let n = 64320; n < 77120; n++) t[n] *= 1.6
}, 'joint_gate')

// 周期等间隔响动：多个相差 >1ms 却同样达标的对齐 => 不唯一
{
  const Fx = 16000, N = 5 * Fx, Fr = 16000, delta = 4000
  const ref = new Float64Array(6 * Fx), period = 0.37 * Fr
  for (let m = 0; m < ref.length; m++) {
    ref[m] = 0.2 * Math.sin(2 * Math.PI * 100 * m / Fr)
    const phase = (m + delta) % period
    if (phase < 40) ref[m] += 0.5 * Math.exp(-phase / 12)
  }
  const main = { rate: Fx, frames: N, tracks: [new Float64Array(N), new Float64Array(N)] }
  for (let n = 0; n < N; n++) {
    const m = n + delta
    main.tracks[0][n] = 0.3 * ref[m]; main.tracks[1][n] = -0.2 * ref[m]
  }
  try {
    fitCalibration({ main, reference: { rate: Fr, frames: ref.length, tracks: [ref] },
      first: { start: 0.3, end: 1.2 }, second: { start: 4.0, end: 4.9 } })
    check('响动对应不唯一拒绝', false, '未拒绝')
  } catch (error) {
    check('响动对应不唯一拒绝', error.details?.reason === 'ambiguous_correspondence', error.details?.reason)
  }
}

if (failures) { console.error(`\n${failures} 项自检失败`); process.exit(1) }
console.log('\n机器声参考消声自检全部通过。')
