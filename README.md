# 听纹修复

打开页面获得内置三秒录音及一块污染选区。可导入自己的 WAV，在谱图拖选或用表单输入数值。添加选区后生成修复，切换原声与修复试听，再下载 PCM WAV。

## 启动

需要 Node.js 20 或更高版本。

```bash
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:4813`。可用 `PORT` 调整端口。前端由原生 HTML、CSS、JavaScript 构成。项目可离线运行，使用本机浏览器和 Node.js 标准库。

## 工作流

- 录音识别。保留声道数、采样率和帧数。
- 谱图计算。窗长变化使真实频格宽度变化。
- 频带衰减。污染选区附近频带能量下降。
- 旁路重建。无选区的输出逐帧等价。
- 量测和 PCM 输出。保持源帧数并给出逐声道差值。

## 帧片段工作台

页面下方「帧片段工作台」把原录音按**零起算半开帧区间**裁成源段（clip），同一源段可多次放到拼接时间线上；每一次放置是一次稳定身份的**出场**（take / occurrence）。

- **重排 / 复用 / 互换**：源段可重复放置；块上「◀ ▶」移动、「⇄同源」交换两次同源出场。选框通过 `takeId` 绑定到“那次出场”，互换后选框随该出场移动，而不是停在原时间坐标。
- **硬切接头**：点击块间接头在软接/硬切间切换，或在输入里给 `hardCuts: [itemId | takeId | index | frame | {after|before|between|at}]`。硬切两侧分别加窗、重建并直接拼接，分析窗不跨接头；替换一侧的等长声音后，另一侧的谱图读数与修复 PCM 样点保持不变。
- **仅为定位的分段**：「✂中点 / ✂帧」把同次出场切成连续多段，它们共享同一 `takeId`，新接头默认软接。这种分段会被重新合并为同一处理跨度，因此选框、谱图 `values/centers` 与修复 PCM16 Base64 完全不变；若原末端是硬切，硬切身份会迁移到右段末端。
- **圈选衰减**：在拼接谱图拖框，会按横坐标定位到所在出场并以“出场内秒”建框；频带按设置衰减，规则与整件修复一致。隔硬切且无选区落入的跨度逐样保留。
- **对听 / 下载**：「原声 · 现顺序」播放按当前排列拼出的 `originalWav`；修复试听与下载使用同一个 `wav`（`repairedWav/downloadWav/auditionWav` 是同一字符串），均为 PCM16 WAV，保留采样率、声道顺序与拼接帧数。

程序化入口（纯 Node，无第三方依赖）：

```js
import { inspectWorkbench, repairWorkbench, workbenchDemo,
  swapAppearances, splitAppearance, readingAt } from './server/workbench/index.mjs'

const state = workbenchDemo()                 // A-B-A，选框绑定后一次 A（a2）
const view  = inspectWorkbench(state)         // originalWav / spectrum / boxes / layout
const done  = repairWorkbench(state)          // wav(PCM16) / metrics / spectrum
```

已知入口 `inspect/repair`（`server/repair/session.mjs`）会在识别到工作台形状（含 `items/timeline/segments/...`）时自动分流，旧的整件 WAV 契约不变（`regions: []` 仍逐字节旁路）。HTTP 规范入口为 `GET /api/spectral-mend/workbench-demo`、`POST /api/spectral-mend/workbench-inspect`、`POST /api/spectral-mend/workbench-repair`；`inspect/repair` 也接受工作台载荷。另挂 `/api/workbench/inspect|repair|demo`、`/api/timeline/...`、`/api/studio/...` 等命名别名。

```bash
node scripts/workbench-checks.mjs   # 12 组逐条不变量自检
npm test                            # node --test：含 test/workbench.test.mjs
```

可参阅 `PROJECT_SPEC.md` 了解输入、规则和接口。构建命令检查语法与服务装载。自动化测试套件留待后续。
