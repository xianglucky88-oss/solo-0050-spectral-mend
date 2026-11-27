# 听纹修复 · 项目规格

短录音频谱修复工具。录音编辑者在谱图上选中污染所在时间与频带，应用衰减后试听并导出 PCM，原音保留以供比较。

## 领域规则

输入为 8–48 kHz、单或双声道、每帧 16 位的 PCM WAV，至少 16 帧、至多 6 秒。频谱采用 256、512 或 1024 点周期 Hann 窗，跳距为窗长四分之一，信号外补零。显示在频率线性轴上聚合最多 160 列，双声道以功率合并，再取同一显示列内的最大值。

选区使用秒、赫兹和衰减分贝，叠加最多八个框。衰减随窗中心和频格中心渐变，多个选区在分贝域累加，镜像频格应用相同增益。选区作用的时间范围受分析窗延展；极窄选区可能没有命中频格。逆变换后按窗平方和归一化并保持采样率、声道和长度。

修复结果的峰值与差值 RMS 在量化前计算，饱和帧对应量化溢出位置。导出执行舍入并饱和到 PCM16。对听使用同一个播放控件，切换信号时尽量延续当前播放点。

## 接口

`GET /api/spectral-mend/demo` 返回内置录音及建议区。`POST /api/spectral-mend/inspect` 接收 Base64 `wav` 和可选 `size` 并返回谱图。`POST /api/spectral-mend/repair` 另收 `regions`，各项含 `start`、`end`、`low`、`high`、`db`，返回 PCM WAV、谱图和逐声道计量。

## 模块

- `server/http` 负责输入尺寸、HTTP 及内容边界。
- `server/audio` 负责WAV 解包、量化和 PCM 布局。
- `server/spectrum` 负责加窗、傅里叶变换和谱图聚合。
- `server/repair` 负责选区、跨窗重建、信号计量和导出。
- `server/workbench` 负责按帧裁段、出场身份、布局/硬切跨度、拼接谱图与隔离修复。
- `public/js` 负责频谱选区交互、工作台重排和双版本对听。

## 帧片段工作台规则

- 源段 clip 是原录音上的零起算半开帧区间；同一段可重复放置。每次放置是身份稳定的出场 take/occurrence，分段 piece 以共享 `takeId` 表示同次出场内仅为定位的连续切分。
- 选框/选区通过 `takeId`（或等价的 `occurrenceId/segmentId` + 出场内帧/秒、源段 id + 第几次复用）绑定到出场；解析结果 `boxes` 给出拼接时间线上的全局帧与归一化 `x0/x1`。重排或交换出场后，选框随该身份移动。
- 硬切接头把时间线划分为互不跨越的处理跨度：每个跨度独立 `windowPlan/columns/rebuild` 后直接拼接。软接头（含同次出场的定位分段）合并为同一跨度，故分段前后 `boxes`、`spectrum.values/centers` 与修复 WAV Base64 完全一致。
- 硬切一侧做等长声音替换（条目 `replacement/wav`、顶层 `replacements` 映射或数组）时，另一侧跨度的谱图读数（`spans[].spectrum` 与 `readAt`）及修复 Int16 样点保持不变；无选区落入的硬切跨度逐样保留。
- 拼接输出为 PCM16 WAV：`rate` 不变、声道顺序不变、帧数等于各片段帧数之和；工作台拼接时长默认仍以 6 秒为界（可用 `maxSeconds` 调整）。`originalWav` 是按当前顺序拼接的原声，`wav/repairedWav/downloadWav/auditionWav` 是同一份修复 WAV。

## 工作台接口

`GET /api/spectral-mend/workbench-demo` 返回 A-B-A 示例状态（选框绑定后一次 A）。`POST /api/spectral-mend/workbench-inspect` 与 `workbench-repair` 接收 `{ wav, size?, clips?, items|timeline|segments|takes|order, hardCuts?, regions? }`，返回 `{ rate, channels, frames/stitchedFrames, originalWav, wav?, spectrum, originalSpectrum?, spans, boundaries, takes, boxes, regions, items, metrics?, editedWindows? }`。既有 `inspect/repair` 与 `/api/spectral-mend/inspect|repair` 在检测到工作台形状时自动分流，否则维持原契约。另提供 `/api/workbench/inspect|repair|demo` 等别名前缀。

## 验证

`npm run build` 检查 ECMAScript 模块语法及服务装载。`.project-runtime.json` 记录可复跑的有界生产工作流检查；`node scripts/workbench-checks.mjs` 与 `npm test`（`test/workbench.test.mjs`）覆盖工作台身份跟随、硬切隔离、等长替换不变性、定位分段透明性、逐样保留与 PCM16 契约。
