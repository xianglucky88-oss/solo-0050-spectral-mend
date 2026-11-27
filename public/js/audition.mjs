import { wavBlob } from './wave-asset.mjs'

// Build a playable URL for a base64 PCM WAV. Blob URLs are preferred; a data
// URI fallback keeps the controller usable in non-browser / stub environments.
export function wavSource(wav) {
  const blob = wavBlob(wav)
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(blob)
      if (typeof url === 'string' && url) return { src: url, objectUrl: url }
    }
  } catch { /* fall through to data URI */ }
  return { src: `data:audio/wav;base64,${wav}`, objectUrl: undefined }
}

// One shared <audio> element for original and repaired takes.
//
// The controller keeps an *intent* (latest wanted playhead position and
// play/pause state) that is updated both by signal switches and by the user's
// own transport operations (native scrubbing, play, pause). Any asynchronous
// source/metadata completion applies that latest intent, so rapid switching,
// dragging and play/pause always settle on the last valid operation.
export function audition(player, options = {}) {
  const createSource = options.wavSource ?? wavSource
  let objectUrl
  let serial = 0
  let position = 0
  let wantPlay = false

  const finiteTime = () => {
    const value = Number(player.currentTime)
    return Number.isFinite(value) && value >= 0 ? value : position
  }

  const rememberPosition = () => { position = finiteTime() }

  player.addEventListener?.('timeupdate', rememberPosition)
  player.addEventListener?.('seeking', rememberPosition)
  player.addEventListener?.('seeked', rememberPosition)
  player.addEventListener?.('play', () => { wantPlay = true })
  player.addEventListener?.('playing', () => { wantPlay = true })
  player.addEventListener?.('pause', () => { wantPlay = false })
  player.addEventListener?.('ended', () => { wantPlay = false })

  function applyLatest() {
    const duration = Number(player.duration)
    let target = Number.isFinite(position) && position >= 0 ? position : 0
    if (Number.isFinite(duration) && duration > 0) target = Math.min(target, duration)
    position = target
    // Setting currentTime before metadata is ready can throw/noop; the
    // loadedmetadata handler calls applyLatest again.
    try {
      if (player.readyState > 0 || Number.isFinite(duration)) player.currentTime = target
    } catch { /* metadata not ready yet */ }
    if (wantPlay && typeof player.play === 'function') {
      try {
        const result = player.play()
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch { /* autoplay blocked or stub player */ }
    }
  }

  // A single persistent handler always applies the newest intent. Stale
  // source loads cannot resurrect an old position/play state because intent is
  // shared and only ever moves forward to the last user operation.
  player.addEventListener?.('loadedmetadata', applyLatest)

  function load(wav, keepPosition) {
    keepPosition = keepPosition === true
    serial += 1
    if (keepPosition) {
      // While a fresh source is loading readyState/currentTime may already be
      // reset to 0; the event-maintained `position` then carries the latest
      // scrub. Only adopt the live playhead when it is credible: a zero live
      // time alongside a known later position is a source reset, not a seek.
      const live = Number(player.currentTime)
      if (player.readyState > 0 && Number.isFinite(live) && (live > 0 || position === 0)) {
        position = live
      }
      wantPlay = !player.paused
    } else {
      position = 0
      wantPlay = false
    }
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl) } catch { /* noop */ }
      objectUrl = undefined
    }
    const source = createSource(wav)
    objectUrl = source.objectUrl
    player.src = source.src
    // Some environments expose metadata synchronously; apply immediately when
    // possible. Browsers normally apply through the loadedmetadata event.
    const duration = Number(player.duration)
    if (player.readyState > 0 && Number.isFinite(duration) && duration > 0) applyLatest()
    return serial
  }

  load.seek = time => {
    const value = Number(time)
    if (!Number.isFinite(value)) return position
    const duration = Number(player.duration)
    position = Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(value, duration) : value)
    try { player.currentTime = position } catch { /* defer to metadata */ }
    return position
  }
  load.play = () => {
    wantPlay = true
    if (typeof player.play === 'function') {
      try {
        const result = player.play()
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch { /* blocked */ }
    }
  }
  load.pause = () => {
    wantPlay = false
    if (typeof player.pause === 'function') player.pause()
  }
  load.position = () => position
  load.playing = () => wantPlay
  load.serial = () => serial
  load.apply = applyLatest
  return load
}
