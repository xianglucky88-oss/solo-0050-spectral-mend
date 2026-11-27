# 听纹修复

短录音频谱修复 + 机器声参考消声工具。录音编辑者可以在谱图上选中污染频段做衰减，
也可以打开“同一台机器”的单声道参考，用前后两段纯机器声校准开录偏移、恒定速率差
和各主声道带符号比例，再在修复区与参考覆盖重合处做波形相减消声。

## 启动

需要 Node.js 20 或更高版本。

```bash
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:4813`。可用 `PORT` 调整端口。前端由原生 HTML、CSS、
JavaScript 构成。项目可离线运行，使用本机浏览器和 Node.js 标准库。

机器声工作流自检（校准门限、1 毫秒对听、四分之一残声、逐码保留与拒绝情形）：

```bash
npm run verify:machine
```

## 机器声参考消声工作流（双件）

1. 打开两件：主录音（单/双声道 PCM16 WAV）与同一台机器的单声道参考。两者允许
   不同开录时间与不同标称采样率（8–48 kHz、≤6 秒）。也可直接点“打开内置双件示范”。
2. 在主录音频谱上分别拖选（或用数值表单）前、后两段**纯机器声**，并圈一个或多个
   **修复区**。
3. 点“校准并共同确认”。两段共用同一组 `rho, delta` 仿射映射
   （`参考采样 = rho × 主采样 + delta`，等价于开录偏移 + 恒定速率差），每个主声道
   拟合一个可正可负的固定比例 `g_c`。
4. 校准通过条件：每段每声道 RMSE ≤ 该段该路 RMS 电平的 5% + 1 个 PCM 码
   （`1/32768`），同次响动/局部对齐偏差 < 1 毫秒。页面给出偏移秒数、速率比/ppm、
   带符号增益、逐段 RMSE 与响动偏差。
5. 生成前可用“主录音 / 校准参考”在**同一播放位置**对听；绿色带显示**参考覆盖**。
6. 点“生成消声成品”。只在修复区 ∩ 参考覆盖内做
   `out_c = in_c − w(n)·g_c·参考(rho·n+delta)`，权重在两端 Hann 平滑。
   校准段、修复区外、参考未覆盖处权重恒为 0，输出 PCM16 与原采样率/声道/帧数一致。
   相干相减只移除与参考相关的机器声，同频但独立的说话声被保留。
7. 用同一组按钮在原声/校准参考/成品间同位置切换对听；“下载成品 WAV”与试听使用
   同一个 Base64 成品。

### 拒绝与重确认

以下情况校准接口返回 `400 { accepted:false, code, reason, error, details }`，
界面用状态行说明原因；更换录音或重新圈选校准区后可再次确认：

- `reason:'silence'`：校准段所有声道（或参考）近乎静音；
- `reason:'ambiguous_correspondence'`：存在两个以上相差 >1 毫秒却同样达标的对齐，
  响动对应不唯一（如等周期脉冲串）；
- `reason:'no_correlation'`：参考与主录音找不到共同对应；
- `reason:'joint_gate'`：单一仿射 + 固定增益无法让两段、各路共同满足 RMSE/覆盖/
  1 毫秒门限（如两段比例不一致、参考覆盖不到）。

## HTTP 接口

所有业务接口前缀 `/api/spectral-mend`，JSON 中的 WAV 为 Base64 PCM16。

原有频谱工作台：

- `GET /demo`、`POST /inspect`、`POST /repair`（字段 `wav,size,regions[{start,end,low,high,db}]`）。

机器声双件工作流：

- `GET /machine-demo`：内置主录音 + 单声道参考及建议校准段/修复区。
- `POST /calibrate`：`{wav|mainWav, referenceWav|reference, first, second}`
  （也接受 `calibration:[r1,r2]`、`zones`、`before/after` 等别名），返回
  `{accepted,rho,delta,gains,calibration:{offsetSeconds,rateRatio,ppm,...},segments,events,coverage}`。
- `POST /align`（别名 `/audition`）：返回与主录音同采样率/声道/帧数的
  “已校准、按声道比例缩放的参考”WAV，供生成前同位置对听。
- `POST /cancel`（别名 `/machine-cancel`、`/machine-repair`）：另收
  `repairs:[{start,end}]`（也接受 `regions` 纯时间区间）、可选 `rho,delta,gains`
  或 `calibration`、`fadeMs`、`stable:{start,end}`。返回
  `{wav,rate,channels,frames,coverage,overlaps,metrics,stable,stableMetrics,cores}`。
  无修复区或无重合时 `wav` 为上传原件的同一 Base64。
- `POST /coverage`：仅计算参考覆盖区间。

Node 侧也可直接从 `server/repair/session.mjs` 导入
`inspect / repair / calibrate / cancel / align / coverage`（`repair` 见到
`referenceWav/reference` 且不是频谱框时自动进入双件消声流程），
或从 `server/machine/api.mjs` 导入完整 API 与不抛异常的 `evaluateCalibration`。

## 原有频谱工作流

打开页面获得内置三秒录音及一块污染选区。可导入自己的 WAV，在谱图拖选或用表单输入
数值。添加选区后生成修复，切换原声与修复试听，再下载 PCM WAV。

- 录音识别。保留声道数、采样率和帧数。
- 谱图计算。窗长变化使真实频格宽度变化。
- 频带衰减。污染选区附近频带能量下降。
- 旁路重建。无选区的输出逐帧等价。
- 量测和 PCM 输出。保持源帧数并给出逐声道差值。

可参阅 `PROJECT_SPEC.md` 了解输入、规则和接口。构建命令检查语法与服务装载。
