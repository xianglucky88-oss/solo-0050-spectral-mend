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
- `public/js` 负责频谱选区交互和双版本对听。

## 验证

`npm run build` 检查 ECMAScript 模块语法及服务装载。`.project-runtime.json` 记录可复跑的有界生产工作流检查。落锁对轨另提供 `node scripts/lock-checks.mjs`（25 组断言）与 `npm test`（`node --test`）。

## 落锁对轨（动画两次改动落锁时刻）

编辑者在波形上圈出一块零起算半开帧区间 `segment=[start,end)` 作为“改动段”，并为每次落锁给出原声搜索范围 `search=[start,end)` 与零起算目标帧 `targetFrame`。流程为“先辨认、显示零起算源帧，再生成”。

- 双路确认。搜索范围内的撞击必须在左右两声部同时成立（允许 `matchTolerance` 内对齐），两声部可强弱不同；显著性按各声道自身电机背景归一。范围内出现 0 个或多于 1 个双路确认撞击即 `unique:false`，返回“请重新圈选”，不生成。
- 32 帧原码搬迁。唯一确认的零起算源帧 `sourceFrame` 起，连续 `BLOCK_FRAMES=32` 帧的双声道有符号 PCM16 原码逐码搬到每个 `targetFrame`，按各落锁的原顺序处理；WAV 经整数刻度编解码保证逐码一致。
- 几何硬约束（`server/lock/geometry.mjs`）。源、目标保护片均为 32 帧，各自集合内不得重叠、不得越出改动段、不得侵入段首尾各 `EDGE_FRAMES=16` 帧。目标片彼此之间、以及目标片与段首尾 16 帧保留区之间，至少留 `JOIN_FRAMES=2` 帧接声净距。
- 电机声连续。源空洞用稳态声线联合最小二乘拟合 + 双端相位/幅度连续外推重建；目标片间隙用源前/后语境领接淡变。保留渐响渐弱包络次序、稳态频率、声道幅度关系与左右相位差。
- 5% 包络规则。逐声线比较保护片外侧两端在成品与原声“原位置同端”的拟合幅度，差不得超过该声线原段峰值的 5%（`tolerance=0.05`）；分析窗在相邻保护片处截断，过短间隙退化为等长局部能量比较。渲染后复核不满足即 `code:'no-join-solution'`，整体放弃、原样回传输入 WAV 并提示调整目标帧。
- 原样边界。改动段首/尾各 16 帧与圈外全部样点逐样不变；任何领域失败（非唯一、几何、接声无解）都返回 `changed:false` 且 `wav===输入 wav`。
- 成品契约。输出与原声同采样率、等长、双声道 PCM16 WAV；页面的试听与下载使用同一个返回 WAV base64 生成的 Blob。

### 落锁接口

- `GET /api/spectral-mend/lock-demo`（别名 `GET /api/lock/demo`）返回双声道内置样本、改动段、两路搜索范围、目标帧与重圈/无解预设。
- `POST /api/spectral-mend/lock-inspect`（别名 `/api/lock/inspect|detect|preview`）接收 `wav`、`segment{start,end}`、`locks:[{search:{start,end},targetFrame}]`，返回每次落锁的 `detections`、零起算 `sourceFrames`、`geometry` 与包络预判；不产出音频。
- `POST /api/spectral-mend/lock-move`（操作别名 `lock|lock-apply|lock-render|relocate`；资源别名 `POST /api/lock`、`/api/lock/move`、`/api/lock-move/move`）在可搬迁时返回 `{ok:true,changed:true,wav,sourceFrames,targetFrames,metrics,envelope,gaps,...}`，否则返回 `{ok:false,changed:false,code,reason,needReselect|adjustTarget,wav:原wav}`。

帧字段缺省按零起算整数帧解释，小数按秒；也可用 `unit:'seconds'|'frames'` 显式声明，并兼容 `circle/range/span`、`target/to/destination`、`cues/impacts/moves` 等常见别名。核心纯函数在 `server/lock/`（`geometry/detect/envelope/motor/relocate/params/session/demo`），统一出口为 `server/lock/index.mjs`，同义命名与路径垫片见 `server/lock/compat.mjs` 及 `server/{impact,relocate-lock,lock-move,...}.mjs`、`server/locks/`、`server/repair/{lock,impact,...}.mjs`。
