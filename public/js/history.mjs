// Versioned editing history with asynchronous activation guards.
//
// A "version" is an immutable snapshot of every restorable part of the work:
// window size, regions, source WAV + inspect spectrum, and (once generated for
// that exact edit state) the repaired product with its own spectrum/metrics
// and exact PCM WAV bytes.
//
// Editing actions (add/remove region, change window size, replace WAV) create
// new draft versions. Generating does not create a version: its product is
// attached, by identity, to the version it was requested from. Late responses
// therefore can never overwrite a different current version.

export function cloneRegions(regions = []) {
  return regions.map(region => ({ ...region }))
}

let globalId = 0
const nextId = () => ++globalId

export function createVersion(input = {}) {
  return {
    id: input.id ?? nextId(),
    takeId: input.takeId ?? 0,
    label: input.label ?? '',
    sourceWav: input.sourceWav ?? '',
    sourceName: input.sourceName ?? '',
    size: input.size ?? 512,
    regions: cloneRegions(input.regions),
    form: input.form ? { ...input.form } : null,
    view: input.view ?? null,
    viewStatus: input.viewStatus ?? 'ready', // ready | loading | error
    viewError: input.viewError ?? null,
    signal: input.signal ?? 'source', // source | result
    productStatus: input.productStatus ?? 'idle', // idle | pending | ready | error
    product: input.product ?? null,
    productError: input.productError ?? null,
    artifactId: input.artifactId ?? null
  }
}

function intact(version) {
  if (!version || !version.sourceWav || !version.view) {
    throw new Error('这个版本缺少可用的声音或谱图。')
  }
  if (version.viewStatus === 'error') {
    throw new Error(version.viewError || '该版本的谱图恢复失败。')
  }
  if (version.productStatus === 'ready' &&
      (!version.product || typeof version.product.wav !== 'string' || !version.product.wav)) {
    throw new Error('旧成品数据不完整，无法恢复。')
  }
  return version
}

// The default restorer only validates resident data. The browser layer injects
// a richer restorer that can reload an off-memory artifact.
export async function defaultRestore(version) {
  return intact(version)
}

export function createHistory(options = {}) {
  const restore = options.restore ?? defaultRestore
  const listeners = new Set()
  let takeSerial = 0

  const state = {
    takeId: 0,
    stack: [],
    index: -1,       // optimistic history cursor
    activeId: null,  // last fully presented version
    pendingId: null, // target of an in-flight activation
    error: null,     // { id, message }
    activation: 0
  }

  function emit() {
    const snapshot = getState()
    for (const listener of listeners) {
      try { listener(snapshot) } catch { /* listener errors must not break the book */ }
    }
  }

  function getState() {
    return {
      takeId: state.takeId,
      stack: state.stack,
      versions: state.stack,
      index: state.index,
      current: state.stack[state.index] ?? null,
      active: state.stack.find(version => version.id === state.activeId) ?? null,
      activeId: state.activeId,
      pendingId: state.pendingId,
      error: state.error,
      canUndo: state.index > 0,
      canRedo: state.index >= 0 && state.index < state.stack.length - 1
    }
  }

  function on(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const subscribe = on

  function get(id) {
    return state.stack.find(version => version.id === id) ?? null
  }
  const version = get

  // Advance the take identity immediately when a WAV switch starts, so a late
  // response from the previous recording can no longer match the current take,
  // even before the fresh inspect result resets the stack.
  function beginTake() {
    takeSerial += 1
    state.takeId = takeSerial
    state.activation += 1
    return state.takeId
  }

  function reset(input = {}) {
    takeSerial += 1
    state.takeId = takeSerial
    const entry = createVersion({ ...input, id: nextId(), takeId: state.takeId })
    state.stack = [entry]
    state.index = 0
    state.activeId = entry.id
    state.pendingId = null
    state.error = null
    state.activation += 1
    emit()
    return entry
  }

  // Create a new edit version from the cursor and discard the redo branch.
  function commit(patch = {}) {
    const base = state.stack[state.index]
    if (!base && !patch.sourceWav) throw new Error('还没有可编辑的录音。')
    const parent = base ?? createVersion({ takeId: state.takeId })
    const entry = createVersion({
      ...parent,
      ...patch,
      id: nextId(),
      takeId: state.takeId,
      regions: patch.regions ?? parent.regions,
      // Every content edit invalidates the previously generated product and
      // returns the draft to the original signal unless explicitly overridden.
      signal: patch.signal ?? 'source',
      // Every content edit invalidates the previously generated product.
      productStatus: patch.productStatus ?? 'idle',
      product: Object.prototype.hasOwnProperty.call(patch, 'product') ? patch.product : null,
      productError: null,
      artifactId: patch.artifactId ?? null
    })
    state.stack = state.stack.slice(0, state.index + 1)
    state.stack.push(entry)
    state.index = state.stack.length - 1
    state.activeId = entry.id
    state.pendingId = null
    state.error = null
    state.activation += 1 // invalidate any in-flight activation
    emit()
    return entry
  }

  function patchVersion(id, patch = {}) {
    const entry = get(id)
    if (!entry) return null
    Object.assign(entry, patch)
    if (Array.isArray(patch.regions)) entry.regions = cloneRegions(patch.regions)
    emit()
    return entry
  }

  function moveTo(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.stack.length) return null
    state.index = index
    const target = state.stack[index]
    state.pendingId = target.id
    state.error = null
    const seq = ++state.activation
    emit()
    return { seq, target }
  }

  async function activate(move) {
    const moved = typeof move === 'number' ? moveTo(move) : move
    if (!moved) return null
    const { seq, target } = moved
    try {
      const loaded = await restore(target, { takeId: state.takeId })
      if (seq !== state.activation) return null // a newer operation superseded this one
      if (loaded && loaded !== target && typeof loaded === 'object') {
        // A restoring loader may enrich the entry (e.g. fetched artifact).
        const position = state.stack.findIndex(v => v.id === target.id)
        if (position >= 0) state.stack[position] = { ...target, ...loaded }
      }
      state.activeId = target.id
      state.pendingId = null
      state.error = null
      emit()
      return state.stack.find(v => v.id === target.id) ?? target
    } catch (error) {
      if (seq !== state.activation) return null
      // Keep the last successfully presented version on screen and ask for retry.
      state.index = Math.max(0, state.stack.findIndex(v => v.id === state.activeId))
      if (state.index < 0) state.index = 0
      state.pendingId = null
      state.error = { id: target.id, message: error?.message || '旧成品恢复失败。' }
      emit()
      throw error
    }
  }

  function undo() {
    if (state.index <= 0) return Promise.resolve(null)
    return activate(state.index - 1)
  }
  function redo() {
    if (state.index < 0 || state.index >= state.stack.length - 1) return Promise.resolve(null)
    return activate(state.index + 1)
  }
  function goTo(id) {
    const index = state.stack.findIndex(v => v.id === id)
    if (index < 0 || index === state.index && state.activeId === id && !state.error) {
      return Promise.resolve(state.stack[index] ?? null)
    }
    if (index < 0) return Promise.resolve(null)
    return activate(index)
  }
  function retry() {
    if (!state.error) return Promise.resolve(null)
    const index = state.stack.findIndex(v => v.id === state.error.id)
    if (index < 0) return Promise.resolve(null)
    return activate(index)
  }
  function dismissError() {
    state.error = null
    emit()
  }

  // ---- asynchronous generation / inspection tokens -----------------------
  // A token binds a response to the exact take + version + request revision.
  function begin(versionId) {
    const entry = get(versionId)
    if (!entry) return null
    entry.requestSeq = (entry.requestSeq ?? 0) + 1
    entry.productStatus = 'pending'
    entry.productError = null
    emit()
    return { takeId: state.takeId, id: entry.id, seq: entry.requestSeq }
  }

  function isCurrentTake(token) {
    return !!token && token.takeId === state.takeId
  }

  // Returns 'active' | 'background' | 'missing' | 'stale' | 'wrong-take'.
  function resolveProduct(token, product) {
    if (!token || token.takeId !== state.takeId) return 'wrong-take'
    const entry = get(token.id)
    if (!entry) return 'missing'
    if (entry.requestSeq !== token.seq) return 'stale'
    entry.product = product
    entry.productStatus = 'ready'
    entry.productError = null
    entry.artifactId = product?.id ?? entry.artifactId ?? null
    emit()
    return state.activeId === entry.id ? 'active' : 'background'
  }

  function rejectProduct(token, message) {
    if (!token || token.takeId !== state.takeId) return 'wrong-take'
    const entry = get(token.id)
    if (!entry) return 'missing'
    if (entry.requestSeq !== token.seq) return 'stale'
    entry.productStatus = 'error'
    entry.productError = message || '修复生成失败。'
    emit()
    return state.activeId === entry.id ? 'active' : 'background'
  }

  function resolveView(token, view) {
    if (!token || token.takeId !== state.takeId) return 'wrong-take'
    const entry = get(token.id)
    if (!entry) return 'missing'
    if (entry.viewSeq !== token.seq) return 'stale'
    entry.view = view
    entry.viewStatus = 'ready'
    entry.viewError = null
    emit()
    return state.activeId === entry.id ? 'active' : 'background'
  }

  function rejectView(token, message) {
    if (!token || token.takeId !== state.takeId) return 'wrong-take'
    const entry = get(token.id)
    if (!entry) return 'missing'
    if (entry.viewSeq !== token.seq) return 'stale'
    entry.viewStatus = 'error'
    entry.viewError = message || '谱图计算失败。'
    emit()
    return state.activeId === entry.id ? 'active' : 'background'
  }

  function beginView(versionId) {
    const entry = get(versionId)
    if (!entry) return null
    entry.viewSeq = (entry.viewSeq ?? 0) + 1
    entry.viewStatus = 'loading'
    return { takeId: state.takeId, id: entry.id, seq: entry.viewSeq }
  }

  return {
    getState, snapshot: getState, state, on, subscribe,
    reset, commit, get, version: get, patchVersion,
    undo, redo, goTo, retry, dismissError, beginTake,
    begin, beginView, resolveProduct, rejectProduct, resolveView, rejectView,
    isCurrentTake
  }
}

// Convenience alias for callers that prefer a class-shaped API.
export class HistoryBook {
  constructor(options) { Object.assign(this, createHistory(options)) }
}
