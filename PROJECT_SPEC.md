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
- `server/machine` 负责双件校准、仿射对齐、响动校验、参考覆盖与波形相减消声。
- `public/js` 负责频谱选区交互、双版本对听和机器声双件工作流。

## 机器声参考消声领域规则

另输入一份同一台机器的单声道参考 WAV，允许与主录音不同开录时间、不同标称采样率。
主录音上前、后各圈一段纯机器声，两段共用同一仿射映射
`m = rho·n + delta`（`n` 为主采样帧、`m` 为参考采样帧），等价于一个开录偏移
`delta/Fr` 秒与一个恒定物理速率比 `k = rho·Fx/Fr`；每个主声道另有固定、可带符号
的比例 `g_c = Σ x_c·z / Σ z²`，两段合并拟合。

- 校准合格：每段、每声道拟合 RMSE ≤ 该段该声道 RMS 电平的 5% 加 1 码
  （`1/32768`）；同一响动/局部块对齐偏差 < 1 毫秒。
- 静音段（所有声道 RMS 低于约 4 码）、参考静音、响动对应不唯一（存在 ≥2 个相差
  >1ms 却同样达标的对齐）、或单一映射无法让两段各路与响动共同达标时，拒绝并给出
  中文原因与逐项计量；更换录音或校准区后可重新确认。
- 对齐使用 Kaiser 窗 sinc 连续插值、FFT 互相关多峰初值、包络双锚点速率估计与
  高斯-牛顿联合精修；周期等峰按“最接近零偏差”取值，全局多解用于歧义判定。
- 消声权重只在修复区 ∩ 参考插值核完整覆盖内非零；校准段强制为零（即使与修复区
  重叠），修复区外与未覆盖处为零。各处理分量两端做 Hann 平滑。权重为零的采样保留
  原 Float64/PCM16 值，因此校准段、圈外、未覆盖处逐码原样；无处理帧时返回上传 WAV
  的同一 Base64。
- 相干波形相减保留与参考不相关的同频说话声。稳段（调用方给出的 `stable` 区间，
  或缺省的修复区去边核心）残余机器声 RMS 应低于修前四分之一。
- 成品经舍入饱和到 PCM16，保持主录音原采样率、声道数与帧数；试听与下载使用同一成品。

### 机器声接口

`GET /api/spectral-mend/machine-demo` 返回 `{mainWav,referenceWav,first,second,repairs,stable}`。
`POST /api/spectral-mend/calibrate` 输入两件 WAV Base64 与前后区间，返回校准与逐段/
响动/覆盖计量，拒绝为 4xx 且体含 `accepted:false,code,reason,details`。
`POST /api/spectral-mend/align` 返回同主录音格式的已校准参考 WAV 供生成前同位置对听。
`POST /api/spectral-mend/cancel` 按 `repairs` 与校准参数消声，返回成品 WAV、覆盖、
重合区间与稳段计量。别名：`/coverage`、`/audition`、`/machine-cancel`、
`/machine-repair`。`server/repair/session.mjs` 同时导出
`calibrate/cancel/align/coverage`，且 `repair` 在检测到参考输入时转入该工作流。

## 验证

`npm run build` 检查 ECMAScript 模块语法及服务装载。`.project-runtime.json` 记录可复跑的有界生产工作流检查。`npm run verify:machine` 运行机器声工作流的有界断言。自动化测试套件留待后续。
