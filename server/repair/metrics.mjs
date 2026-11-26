export function metrics(before, after) {
  return before.tracks.map((track, channel) => {
    let originalPeak = 0, outputPeak = 0, delta = 0, saturation = 0
    for (let i = 0; i < track.length; i++) {
      const output = after.tracks[channel][i]
      originalPeak = Math.max(originalPeak, Math.abs(track[i]))
      outputPeak = Math.max(outputPeak, Math.abs(output))
      delta += (track[i] - output) ** 2
      const quantized = Math.round(output * 32768)
      if (quantized < -32768 || quantized > 32767) saturation++
    }
    return { originalPeak, outputPeak, differenceRms: Math.sqrt(delta / track.length), saturation }
  })
}
