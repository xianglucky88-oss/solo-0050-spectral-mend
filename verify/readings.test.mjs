// 读数拟合与 2 码容差的边界核验。
import { readChannel, withinTolerance } from '../server/handoff/readings.mjs'

let passed = 0
const check = (name, condition) => {
  if (!condition) { console.error(`✗ ${name}`); process.exitCode = 1 }
  else { passed++; console.log(`✓ ${name}`) }
}

const rate = 1000, frames = 200
// 已知直流 + 单一余弦/正弦，系数为整数码值，便于精确断言。
const codes = [Int16Array.from({ length: frames }, (_, n) =>
  Math.round(7 + 3 * Math.cos(2 * Math.PI * 10 / rate * n) - 2 * Math.sin(2 * Math.PI * 10 / rate * n)))]
const segment = { first: 0, last: frames - 1 }
const result = readChannel(codes, 0, rate, segment, [10])
check('拟合读数唯一', result.unique === true)
const [direct, tone] = result.readings
check('0 Hz 读出带符号平均码值', Math.abs(direct.cosine - 7) < 1e-9)
check('正余弦系数在拟合精度内恢复', Math.abs(tone.cosine - 3) < 0.1 && Math.abs(tone.sine + 2) < 0.1)

// 容差边界：在拟合读数上恰好偏移 2 码通过，超过 2 码拒绝。
const shifted = [{ frequency: 0, cosine: direct.cosine + 2, sine: 0 },
  { frequency: 10, cosine: tone.cosine + 2, sine: tone.sine }]
check('2 码整差在容差内', withinTolerance(result.readings, shifted))
const over = [{ frequency: 0, cosine: direct.cosine, sine: 0 },
  { frequency: 10, cosine: tone.cosine, sine: tone.sine + 2.001 }]
check('超过 2 码拒绝', withinTolerance(result.readings, over) === false)

// 读数不唯一：核听段过短、频点过多导致设计矩阵秩亏。
const degenerate = readChannel(codes, 0, rate, { first: 0, last: 2 }, [10, 20, 30])
check('秩亏时读数标记不唯一', degenerate.unique === false)

// 首帧为相位零点：平移核听段不改变全局相位约定下的同一系数。
const shiftedSegment = readChannel(codes, 0, rate, { first: 50, last: 149 }, [10])
check('不同核听段同一相位零点', Math.abs(shiftedSegment.readings[1].cosine - 3) < 0.3 &&
  Math.abs(shiftedSegment.readings[1].sine + 2) < 0.3)

console.log(`\n${passed} 项通过`)
