// 领域尺寸常量。长录音走流式/分块路径，任何工作缓存都以这些上界为限，
// 不随录音总帧数增长。
export const MAX_SECONDS = 300 // 五分钟
export const SHORT_SECONDS = 6 // 六秒内沿用旧版逐样路径
export const MIN_FRAMES = 16
export const MAX_REGIONS = 8
export const MAX_AUDITION_SECONDS = 10
export const SPECTRUM_COLUMNS = 160
export const MAX_UPLOAD_BYTES = 90_000_000 // 48k/双声道/5 分钟 PCM16 约 57.6MB，留头部余量
export const WINDOW_SIZES = [256, 512, 1024]
