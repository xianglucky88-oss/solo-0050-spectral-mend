// 落锁撞击辨认：两路声道必须在同一帧（允许少量对齐容差）同时确认，
// 两个声部可强弱不同——显著性按各声道自身的电机背景归一，绝对增益不影响结论。
// 搜索范围内必须恰好有一个“双路确认且显著”的撞击；0 个或多个都返回
// unique:false，由上层提示重新圈选（“找不到唯一撞击就提示重圈”）。

export const DETECT_DEFAULTS = {
  candidateRatio: 0.42,  // 相对联合最强起始的候选门槛
  channelRatio: 0.30,    // 单声道相对自身最强起始的门槛
  prominence: 5.0,       // 撞击起始幅度相对典型电机起始的显著倍数（电机约 2–3，撞击常 >20）
  absAmpFloor: 120,      // int16 幅度绝对地板，防止极弱噪声被当成撞击
  matchTolerance: 1,     // 两路峰帧对齐容差（帧）
  refractory: 24         // 相隔小于该帧数的峰视为同一次撞击
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[idx]
}

// 逐帧起始幅度 o[i]=max(0, |x[i]|-|x[i-1]|)。
// 对在第 f 帧起跳、随后衰减/回落的撞击，最大值精确落在零起算的 f。
export function onsetProfile(channel, from, to) {
  const values = new Array(Math.max(0, to - from)).fill(0)
  for (let i = Math.max(1, from); i < to; i++) {
    const d = Math.abs(channel[i]) - Math.abs(channel[i - 1])
    values[i - from] = d > 0 ? d : 0
  }
  return values
}

function analyzeChannel(channel, from, to) {
  const profile = onsetProfile(channel, from, to)
  let peak = 0
  for (const v of profile) if (v > peak) peak = v
  const positive = profile.filter(v => v > 0).sort((a, b) => a - b)
  // 典型电机起始取正起始的较高分位，避免被大量 0 拉到地板。
  const typical = percentile(positive, 0.7) || peak
  return { profile, peak, typical }
}

// 在 [from,to) 内寻找唯一双路确认撞击。pcm 为有符号整数声道数组。
export function detectImpact(pcm, from, to, overrides = {}) {
  const opt = { ...DETECT_DEFAULTS, ...overrides }
  const fail = (code, reason, extra = {}) => ({ unique: false, confirmed: false, frame: null,
    zeroBasedFrame: null, code, reason, candidates: [], ...extra })

  if (!Array.isArray(pcm) || pcm.length < 2) {
    return fail('need-stereo', '落锁辨认需要左右两路声道同时确认。')
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || to - from < 2) {
    return fail('range-invalid', '原声搜索范围至少要有 2 个完整帧。')
  }

  const a0 = analyzeChannel(pcm[0], from, to)
  const a1 = analyzeChannel(pcm[1], from, to)
  if (!(a0.peak > 0) || !(a1.peak > 0)) {
    return fail('no-impact', '搜索范围内没有可辨认的撞击，请重新圈选原声搜索范围。')
  }

  // 增益无关的归一化起始分；联合分用两路之和，体现“两路同时确认”。
  const n0 = a0.profile.map(v => v / a0.peak)
  const n1 = a1.profile.map(v => v / a1.peak)
  const joint = n0.map((v, i) => v + n1[i])

  let bestOffset = 0
  for (let i = 1; i < joint.length; i++) if (joint[i] > joint[bestOffset]) bestOffset = i
  const bestFrame = from + bestOffset

  // 双路在最强帧都要达到自身门槛，且相对各自电机背景足够显著。
  const prominent0 = a0.peak >= opt.prominence * a0.typical && a0.peak >= opt.absAmpFloor
  const prominent1 = a1.peak >= opt.prominence * a1.typical && a1.peak >= opt.absAmpFloor
  const atBest0 = n0[bestOffset] >= opt.channelRatio
  const atBest1 = n1[bestOffset] >= opt.channelRatio
  if (!prominent0 || !prominent1 || !atBest0 || !atBest1) {
    return fail('no-impact', '电机背景中没有两路同时确认的突出撞击，请重新圈选原声搜索范围。',
      { channelPeaks: [a0.peak / 32768, a1.peak / 32768] })
  }

  // 候选局部峰：联合分达到最强的一定比例，且双路在该帧（或容差内）分别
  // 达到相对自身电机背景的显著性——较弱的第二次撞击也要能被数到。
  const threshold = opt.candidateRatio * joint[bestOffset]
  const peaks = []
  for (let i = 0; i < joint.length; i++) {
    if (joint[i] < threshold) continue
    if (i > 0 && joint[i] < joint[i - 1]) continue
    if (i + 1 < joint.length && joint[i] < joint[i + 1]) continue
    if (!channelConfirms(n0, n1, i, opt)) continue
    if (!channelProminent(a0, i, from, opt) || !channelProminent(a1, i, from, opt)) continue
    peaks.push({ frame: from + i, joint: joint[i] })
  }
  const merged = mergeRefractory(peaks, opt.refractory)

  const candidates = merged.map(c => ({
    frame: c.frame, zeroBasedFrame: c.frame, joint: c.joint,
    leftStrength: clusterStrength(pcm[0], c.frame, opt.refractory),
    rightStrength: clusterStrength(pcm[1], c.frame, opt.refractory)
  }))

  if (candidates.length === 0) {
    return fail('no-impact', '没有找到两路同时确认的撞击，请重新圈选原声搜索范围。')
  }
  if (candidates.length > 1) {
    return fail('not-unique', `搜索范围内有 ${candidates.length} 个被双路确认的撞击，无法确定唯一落锁，请缩小范围后重圈。`,
      { candidates })
  }
  const only = candidates[0]
  return { unique: true, confirmed: true, frame: only.frame, zeroBasedFrame: only.frame,
    sourceFrame: only.frame, code: 'unique', reason: null, candidates,
    leftStrength: only.leftStrength, rightStrength: only.rightStrength,
    strengths: [only.leftStrength, only.rightStrength] }
}

function channelConfirms(n0, n1, i, opt) {
  for (let d = 0; d <= opt.matchTolerance; d++) {
    for (const j of [i - d, i + d]) {
      if (j < 0 || j >= n0.length) continue
      if (n0[j] >= opt.channelRatio && n1[j] >= opt.channelRatio) return true
    }
  }
  return false
}

function channelProminent(analysis, i, from, opt) {
  let value = 0
  for (let j = Math.max(0, i - opt.matchTolerance); j <= i + opt.matchTolerance && j < analysis.profile.length; j++) {
    value = Math.max(value, analysis.profile[j] ?? 0)
  }
  return value >= opt.prominence * analysis.typical && value >= opt.absAmpFloor
}

function clusterStrength(channel, frame, radius) {
  let peak = 0
  for (let i = Math.max(0, frame - 2); i < Math.min(channel.length, frame + Math.min(radius, 8)); i++) {
    peak = Math.max(peak, Math.abs(channel[i]))
  }
  return peak / 32768
}

function mergeRefractory(peaks, gap) {
  const sorted = [...peaks].sort((a, b) => a.frame - b.frame || b.joint - a.joint)
  const out = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && p.frame - last.frame < gap) {
      if (p.joint > last.joint) { last.frame = p.frame; last.joint = p.joint }
    } else out.push({ ...p })
  }
  return out
}

// 批量辨认，保持入参顺序（即各次落锁/原声搜索范围的原顺序）。
export function detectLocks(pcm, ranges, options) {
  return ranges.map((range, index) => {
    const from = range.start ?? range.from ?? range[0]
    const to = range.end ?? range.to ?? range[1]
    const result = detectImpact(pcm, from, to, options)
    return { index, ...result, sourceFrame: result.frame, zeroBasedSourceFrame: result.frame }
  })
}
