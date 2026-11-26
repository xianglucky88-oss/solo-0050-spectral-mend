// 命名兼容入口：PCM16 整数刻度、减半与工作台舍入工具见 ./pcm16.mjs 与 ../repair/flattops.mjs
export * from './pcm16.mjs'
export { halveSample, halveSamples, findFlatTops, renderFlatTops } from '../repair/flattops.mjs'
