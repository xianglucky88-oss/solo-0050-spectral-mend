export function transform(real, imaginary, inverse = false) {
  const size = real.length
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1
    while (reversed & bit) { reversed ^= bit; bit >>= 1 }
    reversed ^= bit
    if (index < reversed) {
      const realValue = real[index], imaginaryValue = imaginary[index]
      real[index] = real[reversed]
      imaginary[index] = imaginary[reversed]
      real[reversed] = realValue
      imaginary[reversed] = imaginaryValue
    }
  }
  for (let span = 2; span <= size; span *= 2) {
    const step = (inverse ? 1 : -1) * 2 * Math.PI / span
    const cos = Math.cos(step), sin = Math.sin(step)
    for (let offset = 0; offset < size; offset += span) {
      let u = 1, v = 0
      for (let j = 0; j < span / 2; j++) {
        const left = offset + j, right = left + span / 2
        const r = real[right] * u - imaginary[right] * v
        const i = real[right] * v + imaginary[right] * u
        real[right] = real[left] - r; imaginary[right] = imaginary[left] - i
        real[left] += r; imaginary[left] += i
        const next = u * cos - v * sin
        v = u * sin + v * cos; u = next
      }
    }
  }
  if (inverse) for (let i = 0; i < size; i++) {
    real[i] /= size
    imaginary[i] /= size
  }
}
