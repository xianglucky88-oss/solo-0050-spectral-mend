// 通用最小二乘求解：列秩不足（Gram 非正定）时返回 null，表示读数不唯一。
export function solveSystem(columns, observations) {
  const count = observations.length, width = columns.length
  const gram = Array.from({ length: width }, () => new Float64Array(width))
  const dot = new Float64Array(width)
  for (let p = 0; p < width; p++) {
    for (let q = 0; q <= p; q++) {
      let sum = 0
      for (let n = 0; n < count; n++) sum += columns[p][n] * columns[q][n]
      gram[p][q] = gram[q][p] = sum
    }
    let sum = 0
    for (let n = 0; n < count; n++) sum += columns[p][n] * observations[n]
    dot[p] = sum
  }
  const lower = Array.from({ length: width }, () => new Float64Array(width))
  const scale = Math.max(1, count)
  for (let p = 0; p < width; p++) {
    for (let q = 0; q <= p; q++) {
      let sum = gram[p][q]
      for (let k = 0; k < q; k++) sum -= lower[p][k] * lower[q][k]
      if (p === q) {
        if (!(sum > scale * Number.EPSILON * 1e6)) return null
        lower[p][q] = Math.sqrt(sum)
      } else lower[p][q] = sum / lower[q][q]
    }
  }
  const intermediate = new Float64Array(width), answer = new Float64Array(width)
  for (let p = 0; p < width; p++) {
    let sum = dot[p]
    for (let k = 0; k < p; k++) sum -= lower[p][k] * intermediate[k]
    intermediate[p] = sum / lower[p][p]
  }
  for (let p = width - 1; p >= 0; p--) {
    let sum = intermediate[p]
    for (let k = p + 1; k < width; k++) sum -= lower[k][p] * answer[k]
    answer[p] = sum / lower[p][p]
  }
  return answer
}
