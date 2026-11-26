import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { columns } from '../spectrum/columns.mjs'
import { regions } from './regions.mjs'
import { metrics } from './metrics.mjs'
import { rebuild } from './rebuild.mjs'

export function inspect(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  return { rate: audio.rate, frames: audio.frames, channels: audio.tracks.length, spectrum: columns(audio, plan) }
}

export function repair(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  const edited = rebuild(audio, plan, regions(input.regions, audio))
  return { wav: encode(edited).toString('base64'), editedWindows: edited.editedWindows,
    metrics: metrics(audio, edited), spectrum: columns(edited, plan) }
}
