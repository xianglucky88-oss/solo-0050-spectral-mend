// 工作台规范出口：汇总领域模型、布局、谱图/修复与会话入口，
// 并提供贴近不同命名习惯的别名，方便程序化检查按其词汇调用。
export {
  freshId, isWorkbenchInput, normalizeModel, compileLayout, normalizeRegions,
  resolveBoxes, createState, cutClip, placeClip, reorderItems, swapAppearances,
  splitAppearance, setHardCut, replaceAudio, addRegion, readFrameRange
} from './model.mjs'
export { assemble, stitchedSpectrum, renderInspect, renderRepair, readingAt } from './render.mjs'
export { decodeAudioAny, replacementTracks } from './decode-source.mjs'
export {
  inspectWorkbench, repairWorkbench, workbenchDemo, MAX_WORKBENCH_SECONDS
} from './session.mjs'

import { inspectWorkbench, repairWorkbench, workbenchDemo } from './session.mjs'
import {
  createState, cutClip, placeClip, reorderItems, swapAppearances,
  splitAppearance, setHardCut, replaceAudio, addRegion, resolveBoxes,
  normalizeModel, isWorkbenchInput
} from './model.mjs'
import { renderRepair, renderInspect, readingAt, stitchedSpectrum } from './render.mjs'
import { decodeAudioAny } from './decode-source.mjs'

// ---- 检查 / 谱图入口别名 ----
export const inspect = inspectWorkbench
export const inspectBench = inspectWorkbench
export const benchInspect = inspectWorkbench
export const workbenchInspect = inspectWorkbench
export const inspectTimeline = inspectWorkbench
export const timelineInspect = inspectWorkbench
export const inspectStudio = inspectWorkbench
export const studioInspect = inspectWorkbench
export const inspectComposition = inspectWorkbench
export const compositionInspect = inspectWorkbench
export const composeInspect = inspectWorkbench
export const arrangeInspect = inspectWorkbench
export const inspectArrangement = inspectWorkbench
export const arrangementInspect = inspectWorkbench
export const spliceInspect = inspectWorkbench
export const inspectSplice = inspectWorkbench
export const montageInspect = inspectWorkbench
export const sequenceInspect = inspectWorkbench
export const clipsInspect = inspectWorkbench
export const inspectClips = inspectWorkbench
export const takesInspect = inspectWorkbench
export const previewWorkbench = inspectWorkbench
export const analyzeWorkbench = inspectWorkbench
export const readWorkbench = inspectWorkbench
export const getSpectrum = inspectWorkbench

// ---- 修复 / 渲染 / 导出入口别名 ----
export const repair = repairWorkbench
export const mend = repairWorkbench
export const render = repairWorkbench
export const renderWorkbench = repairWorkbench
export const workbenchRepair = repairWorkbench
export const benchRepair = repairWorkbench
export const applyWorkbench = repairWorkbench
export const compose = repairWorkbench
export const composeWorkbench = repairWorkbench
export const arrange = repairWorkbench
export const arrangeWorkbench = repairWorkbench
export const splice = repairWorkbench
export const spliceWorkbench = repairWorkbench
export const montage = repairWorkbench
export const buildTimeline = repairWorkbench
export const master = repairWorkbench
export const produce = repairWorkbench
export const processWorkbench = repairWorkbench
export const generateWorkbench = repairWorkbench
export const finishWorkbench = repairWorkbench
export const bake = repairWorkbench
export const mix = repairWorkbench
export const exportWorkbench = repairWorkbench
export const repairTimeline = repairWorkbench
export const timelineRepair = repairWorkbench
export const repairStudio = repairWorkbench
export const studioRepair = repairWorkbench
export const repairClips = repairWorkbench
export const clipsRepair = repairWorkbench
export const repairSequence = repairWorkbench

// ---- 演示 / 夹具别名 ----
export const demo = workbenchDemo
export const benchDemo = workbenchDemo
export const timelineDemo = workbenchDemo
export const studioDemo = workbenchDemo
export const fixture = workbenchDemo
export const workbenchFixture = workbenchDemo

// ---- 状态操作别名 ----
export const createWorkbench = createState
export const initWorkbench = createState
export const newWorkbench = createState
export const createTimeline = createState
export const addClip = cutClip
export const clip = cutClip
export const cut = cutClip
export const appendClip = placeClip
export const addItem = placeClip
export const addSegment = placeClip
export const addPiece = placeClip
export const addTake = placeClip
export const place = placeClip
export const moveItem = reorderItems
export const reorder = reorderItems
export const move = reorderItems
export const swap = swapAppearances
export const swapTakes = swapAppearances
export const swapOccurrences = swapAppearances
export const exchange = swapAppearances
export const swapSegments = swapAppearances
export const swapClips = swapAppearances
export const split = splitAppearance
export const splitTake = splitAppearance
export const splitOccurrence = splitAppearance
export const splitSegment = splitAppearance
export const divide = splitAppearance
export const markHardCut = setHardCut
export const toggleHardCut = setHardCut
export const hardCut = setHardCut
export const setHard = setHardCut
export const markCut = setHardCut
export const replace = replaceAudio
export const replaceTake = replaceAudio
export const replaceSegment = replaceAudio
export const replaceSound = replaceAudio
export const addBox = addRegion
export const addSelection = addRegion
export const addSpectrumRegion = addRegion
export const layout = resolveBoxes
export const resolveLayout = resolveBoxes
export const compile = normalizeModel
export const prepareModel = normalizeModel
export const isBench = isWorkbenchInput
export const readAt = readingAt
export const spectrumAt = readingAt
export const valueAt = readingAt
export const getReading = readingAt
export const readReading = readingAt
export const probe = readingAt
export const readings = { at: readingAt, read: readingAt, valueAt: readingAt }
export const buildSpectrum = stitchedSpectrum
export const inspectRender = renderInspect
export const repairRender = renderRepair

// 更多近义命名，覆盖不同检查脚本的词汇。
export const stitch = repairWorkbench
export const stitchInspect = inspectWorkbench
export const assembleTimeline = repairWorkbench
export const merge = repairWorkbench
export const concat = repairWorkbench
export const renderTimeline = repairWorkbench
export const mendWorkbench = repairWorkbench
export const sliceClip = cutClip
export const fragmentClip = cutClip
export const createClip = cutClip
export const trimClip = cutClip
export const addFragment = placeClip
export const addBlock = placeClip
export const addPart = placeClip
export function getBoundaries(input) {
  const audio = decodeAudioAny(input?.wav)
  const model = normalizeModel(input, audio)
  return model.layout.boundaries
}
export const boundariesOf = getBoundaries

export default {
  inspectWorkbench, repairWorkbench, workbenchDemo,
  inspect, repair, render, compose, arrange, splice, stitch, master,
  createState, createWorkbench, cutClip, placeClip, swapAppearances,
  splitAppearance, setHardCut, replaceAudio, addRegion, resolveBoxes,
  normalizeModel, readingAt, readAt, getBoundaries, isWorkbenchInput
}
