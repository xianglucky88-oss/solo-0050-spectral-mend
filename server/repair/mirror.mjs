export function applyGains(frame, values) {
  const size = frame.real.length
  for (let k = 0; k < size; k++) {
    const gain = values[Math.min(k, size - k)]
    frame.real[k] *= gain
    frame.imaginary[k] *= gain
  }
}
