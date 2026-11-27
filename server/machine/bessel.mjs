export function besselI0Export(x) {
  let sum = 1, term = 1
  const half = x / 2
  for (let k = 1; k < 40; k++) {
    term *= (half / k) ** 2
    sum += term
    if (term < 1e-16 * sum) break
  }
  return sum
}
