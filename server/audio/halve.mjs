// 命名兼容入口：统一减半与 PCM16 工作台舍入
export { halveSample, halveSamples, workbenchRound, quantizePcm16 } from '../repair/flattops.mjs'
export { encodePcm16Wav, decodePcm16 } from './pcm16.mjs'
