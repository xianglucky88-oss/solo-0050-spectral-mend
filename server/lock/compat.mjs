// 命名兼容层：除规范导出（见 ./index.mjs）外，再提供一组常见同义函数名，
// 便于不同调用/检查入口按其习惯命名接入。规范实现始终以 ./ 下模块为准。
export * from './index.mjs'

import { detectImpact, detectLocks } from './detect.mjs'
import { relocate, previewFeasibility } from './relocate.mjs'
import { validateGeometry } from './geometry.mjs'
import { lockInspect, lockMove, lockDemo } from './session.mjs'

export const findImpact = detectImpact
export const findImpacts = detectLocks
export const detectImpacts = detectLocks
export const findUniqueImpact = detectImpact
export const confirmImpact = detectImpact
export const analyzeLocks = lockInspect
export const inspectLocks = lockInspect

export const moveLocks = lockMove
export const relocateLocks = lockMove
export const applyLocks = lockMove
export const renderLocks = lockMove
export const generateLockMove = lockMove
export const lockRelocate = lockMove
export const runLockMove = lockMove

export const planLockMove = relocate
export const relocateFrames = relocate
export const previewLockMove = previewFeasibility
export const validateLayout = validateGeometry
export const checkGeometry = validateGeometry
export const lockGeometry = validateGeometry

export { lockInspect, lockMove, lockDemo }
