# Bilibili Live Video Blocker（B站直播纯音频插件）

> **进入具体直播间后，拦截视频媒体请求，只获取并播放纯音频流，同时保留弹幕等页面功能。**
>
> 插件站在网络层禁止 B站直播的**视频**媒体流请求，而不是接管播放器；
> 声音来自插件自己请求的一路**纯音频流**，让“视频零流量”和“能听到声音”同时成立。
>
> **范围**：只在具体直播间生效（`live.bilibili.com/123456` 与 `/blanc/123456`）。
> 插件**不负责** B站直播首页大屏，也**不控制** B站原生播放器的播放、暂停和音量。

---

## 0. 先说结论（重要）

| 目标 | 状态 |
| --- | --- |
| 阻止 B站直播视频流被持续下载 | ✅ **达成**（实测视频媒体传输 0 字节） |
| **播放中打开开关能立即停止** | ✅ **达成**（实测 1 秒内停止，缓冲零增长） |
| 关闭开关后视频能恢复 | ✅ **达成**（实测 3~6 秒内自行恢复） |
| 长时间运行不恢复下载 | ✅ **达成**（10 分钟保持实测，零恢复） |
| 切换直播间 / 刷新页面后仍生效 | ✅ **达成**（100% 拦截，切换不串音、无实例泄漏） |
| 弹幕、礼物、页面功能保持正常 | ✅ **达成**（弹幕正常，扩展自身 0 错误） |
| **保留 B站原生直播音频** | ✅ **达成（V2）**——由插件单独请求纯音频流播放 |
| **不遮挡 B站原生控制条** | ✅ **达成（V2.1.1）**——28×28 圆形按钮，body 级 `fixed` 定位（见第 6.11 节） |
| **页面内直接开关插件** | ✅ **达成（V2.1.1）**——圆形按钮即入口，与 popup 同一状态来源 |
| **插件自己的音量可调且能记住** | ✅ **达成（V2.2）**——按钮右侧滑块，写 `storage.volume`，刷新/换房间/重开插件都保持（见第 6.12 节） |
| **只在具体直播间生效** | ✅ **达成（V2.2）**——首页大屏支持已整体移除，那里不建立插件音频、不显示插件 UI（见第 6.12 节） |

### V2 与 V1 的差别

V1 的结论是「音频保不住」，**那个结论不完整**：它只测了 Web 播放器用的
`web-room` 接口，而且只检查响应里的 `video_codecs`/`audio_codecs` 字段。
实际问题出在两点：

1. **纯音频流在 App 端接口上**：`xlive/app-room/v2/index/getRoomPlayInfo` + `only_audio=1`
   （`web-room` 接口加上同一个参数完全无效）。且只有 `http_stream/flv` 会变成纯音频，
   `http_hls`（ts / fmp4）即使加了参数仍是音视频双轨。
2. **响应字段会骗人**：`only_audio=1` 返回的 JSON 里 `video_codecs` 依然写着
   `avc1.64001f`，和复用流一模一样。必须下载真实字节去数 FLV tag 才能确认。

实测该流 `FLV flags = 0x4`、`video tag = 0`，AAC-LC 48kHz 双声道，
连续播放 10 分钟零重连，**视频解码 0 字节**，比整条复用流省约 90% 流量。
详见第 5 节。

---

## 1. 这是什么

一个 Manifest V3 浏览器扩展（Chrome / Edge），面向**具体直播间**：

> **Bilibili 直播纯音频插件**：进入具体直播间后，拦截视频媒体请求，
> 仅获取并播放纯音频流，同时保留弹幕等页面功能。

- **不做**：不实现弹幕、不登录、无后端、无数据库；
  **不播放 B站直播首页大屏**，**不控制 B站原生播放器的播放/暂停/音量**。
- **只做**：进入具体直播间（`/123456`、`/blanc/123456`）后，
  用 `declarativeNetRequest` 阻止视频媒体请求，并单独取一路纯音频流播放。

范围边界（明确写下来，避免后续误解）：

| 页面 | 插件行为 |
| --- | --- |
| `live.bilibili.com/<房间号>` | 拦截视频 + 播放纯音频 + 圆形按钮 + 音量滑块 |
| `live.bilibili.com/blanc/<房间号>` | 同上 |
| `live.bilibili.com/`（首页大屏） | **不建立插件音频、不显示插件 UI**；DNR 仍按全局规则拦截视频媒体请求 |

```text
B站直播原有功能
        │
        ├── 直播媒体流（音视频复用）  → ❌ 阻止
        ├── 弹幕（WebSocket）        → ✅ 保持（实测 34~60 个连接正常）
        ├── 礼物 / 榜单 / 在线信息 API → ✅ 保持
        ├── 页面资源 / 播放器 JS      → ✅ 保持
        └── 登录态 API               → ✅ 保持
```

---

## 2. 目录结构

```text
extension/                            ← 加载这个目录
├── manifest.json                     MV3 清单
├── background/service-worker.js      应用/撤销 DNR 规则、统计
├── rules/video-rules.json            静态规则（默认禁用，实际用动态规则）
├── detector/video-request-detector.js  VideoRequestDetector：唯一判决入口
├── shared/bilibili-signatures.js     B站相关逻辑集中在这里（改版只改这个文件）
├── content/
│   ├── hook-injector.js              document_start 注入页面脚本（探针 + V2 播放器）
│   ├── page-probe.js                 页面世界探针（fetch/XHR/MediaSource 观测）
│   ├── probe-reporter.js             验证用上报（无收集器时静默失败）
│   ├── live-state.js                 采集直播间状态 + 测试用开关入口
│   ├── overlay.js                    圆形开关按钮 + 音量滑块 + 提示（纯 UI，仅直播间）
│   ├── audio-player.js               V2 控制层（隔离世界）：房间识别 / 取流 / 重试 / 上报
│   └── audio-page.js                 V2 播放层（页面世界）：mpegts.js 实际播放
├── vendor/mpegts.min.js              mpegts.js 1.7.3（Apache-2.0），本地化，不联网加载
└── popup/                            开关 + 状态 + 统计

tools/                                ← 验证工具，不属于插件，可整体删除
```

> 说明：`content/page-probe.js` 与 `content/probe-reporter.js` 是**实测用的探针**，
> 负责把真实的媒体字节数、`SourceBuffer` 状态、媒体错误上报给本地收集器。
> 它们**不参与拦截**，收集器没运行时请求静默失败，不影响任何功能。
> 如果只想要一个干净的成品，可以删掉这两个文件，并从 `manifest.json` 的
> `content_scripts` / `web_accessible_resources` 中移除对应条目。

---

## 3. 加载与运行

1. 打开 `edge://extensions`（或 `chrome://extensions`）
2. 打开右上角 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择本仓库的 `extension/` 目录
4. 打开任意 B站直播间，点扩展图标，打开 **视频屏蔽** 开关

默认**关闭**：刚安装时不改变 B站任何行为。要求 Chromium 111+。

---

## 4. 拦截方案

### 4.1 为什么用 `declarativeNetRequest`（DNR）

- MV3 下唯一能在**请求发出前**阻止请求、且支持 `block` 动作的官方机制。
- 不需要 `webRequestBlocking`（MV3 下该权限只对策略安装的扩展开放）。
- 拦截在内核层执行，页面 JS 无法绕过。

### 4.2 DNR 的硬限制（实测确认，非漏做）

- **DNR 不能按 MIME / Content-Type 匹配**：规则条件里没有响应头字段。
  响应头只在响应阶段存在，而 `block` 必须在请求阶段决定。
  所以判断只能基于 **URL + 资源类型**。这是方案的天花板。
- **DNR 不报告被阻止请求的体积**，所以统计只给“次数”，流量只给明确标注的估算值。

### 4.3 最终规则

规则由 `shared/bilibili-signatures.js` 生成，JS 判断与 DNR 正则共用同一份常量：

```
^https?://.*/live-bvc/.*\.(?:flv|m3u8|m4s|ts)(?:\?|$)
```

资源类型：`xmlhttprequest / media / other / object / sub_frame`。

### 4.4 为什么按 `/live-bvc/` 而不是按域名（踩过的坑）

最初按 `*.bilivideo.com` 匹配，实测**失效**：播放器在直连 CDN 失败后会走**镜像代理**：

```
https://a5fc91355286fb2e8dc224adc9bc5e15.h2.smtcdns.net/d1--cn-gotcha204b.bilivideo.com/live-bvc/...
└────────────── 代理域名 ────────────────┘ └──────── 原始 CDN 域名 ───────┘
```

实测这条路径提供了 **69 个请求 / 1.34 MB** 媒体数据，视频照常播放（1920×1080）。

两个必须同时满足的修正：

1. **不限制域名**，只依赖 `/live-bvc/` 路径标记。
2. `/live-bvc/` 之前必须用 `.*`，**不能**用 `[^/]*`——镜像 URL 在 `/live-bvc/` 前有**两段**以 `/` 分隔的内容，`[^/]*` 不能跨越 `/`。

> 该错误是被 `tools/selfcheck-detector.mjs` 的单元检查抓到的（167 项中出现 6 项失败），
> 修正后复查通过。这是保留自检脚本的直接收益。

### 4.5 阻止策略

`shared/bilibili-signatures.js` 提供三种，默认 `all`：

| 策略 | 拦住什么 | 实测表现 |
| --- | --- | --- |
| `manifest` | 只拦 `.m3u8` 清单 | 拿不到清单，无法建流；换 CDN 重试 |
| `segments` | 放行清单，拦 `.m4s/.ts/.flv` 分片 | 能建流但拿不到数据；重试更频繁 |
| `all`（默认） | 清单 + 分片 | 重试最少，长时最稳 |

---

## 5. 如何识别视频请求 + 为什么音频保不住

### 5.1 判据

```js
// 路径含 /live-bvc/ 且以直播媒体扩展名结尾
isLiveMediaUrl(url) → { block: true, reason: "bilibili_live_media" }
```

只看**路径前缀 + 扩展名**，不看 `oi / expires / upsig / trid` 等签名参数（每次都变），
不看域名（因为有随机 hash 的镜像代理域名）。

### 5.2 V1 当年的三条“音频无法保留”证据 —— 现在只对 Web 端成立

> **V2 更正**：下面三条证据本身都是实测事实，但它们只覆盖了 **Web 播放器走的
> `web-room` 接口**。它们的结论“B站直播只有复用流”是**不完整**的。
> 纯音频流确实存在，只是不在这个接口上，而且**响应字段看不出来**（见 0 节的说明）。
> 这三条仍然重要：它们解释了为什么 **Web 播放器的流本身必须整体拦掉**。

**证据 A：播放器只建一个 SourceBuffer，MIME 同时含视频与音频 codec**

```
video/mp4; codecs="av01.0.08M.08,mp4a.40.2"
                   └─ AV1 视频 ─┘ └ AAC 音频 ┘
（另一房间实测： hvc1.1.6.L120,mp4a.40.2）
```

**证据 B：fMP4 初始化分片的 moov 同时声明两条 track**

```
h1791201607.m4s → 顶层 box: ftyp moov
                  moov 内 handler: ["vide", "soun"]
```

**证据 C：穷举 playurl 参数也拿不到纯音频流**

```
protocol ∈ {0, 1, 0,1}，format ∈ {0, 1, 2, 0,1,2}，ptype ∈ {8, 0, 2}
共 22 个有效组合、66 个流条目 → 纯音频流 0 个，纯视频流 0 个，全部为音视频复用。
FLV 响应头也只有一个 content-type: video/x-flv（单连接复用）。
```

三条证据指向同一结论：**在 Web 播放器这一条链路上，只能整体放行或整体阻止**。

> 说明：V1 当年未走“自己取音频 + 自己实现播放器”的路线，因为核心目标
> （禁止视频数据持续下载）已通过请求拦截达成，音频保留属于 V2 决策。

**V2 补充的最后一条证据（当年漏掉的）**：穷举里没有测 `app-room` 接口，
也没有下载字节去数 tag。补测后：

```
https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo?...&only_audio=1
  → http_stream / flv → FLV flags = 0x4（纯音频）
  → 60 秒实测：AUDIO tag 2988 个 / VIDEO tag 0 个
  → 对照组（同房间同时刻 only_audio=0）：AUDIO 3138 / VIDEO 2009
  → 响应里的 video_codecs 字段在两种情况下**完全一样**，靠字段判断必然误判
```

而且这条路**不需要**“下载完整流再拆音频”，也不需要自己做 demux：
服务端直接给的就是纯音频字节。这正是 V2 成立的前提。

---

## 6. 实测结果

环境：Windows，Microsoft Edge 154.0.4258.53（Chromium 154），
实测日期 2026-10-05，直播间 `live.bilibili.com/5440` 与 `22637261`。
数据由插件自带探针 + CDP 网络监听采集（原始采集文件属开发期临时产物，冻结前已清理，按第 7 节命令可重新采集）。

### 6.1 A/B 对照（同房间、同扩展，仅开关不同）

| 指标 | 关闭屏蔽 | 开启屏蔽（`all`） |
| --- | --- | --- |
| 媒体请求成功数 | 74 | **0** |
| 媒体数据传输量 | 974,497 字节 | **0** |
| `SourceBuffer` 追加字节 | 6,232,948 | **0** |
| `SourceBuffer` 数量 | 1（`av01+mp4a`） | **0** |
| `<video>` 元素 | 1920×1080，`readyState=4`，播放中 | **不存在** |
| 被阻止的媒体请求 | 0 | 42 |
| 弹幕 WebSocket | 有 | **34 个连接正常** |
| 页面 console 错误 | — | **0** |

开启侧所有被拦请求的 `encodedBodySize` 均为 `0`，证明不是“黑屏但仍在下载”。

### 6.2 视频是否还在持续下载

开启后：`<video>` 元素**从未被创建**，`MediaSource.addSourceBuffer` **从未被调用**
（`sourceBuffers: []`），播放器媒体管线根本没建立。
这是“视频数据没有持续下载”的直接证据。

### 6.3 长时间运行（10 分钟）

| 时间点 | 被阻止请求数 | `SourceBuffer` 字节 | 直播视频元素 |
| --- | --- | --- | --- |
| 60 s | 54 | 0 | 无 |
| 120 s | 55 | 0 | 无 |
| 180~600 s | **55（不再增长）** | **0** | **无** |

播放器在约 60 秒后**放弃重试并保持停止**——没有被阻止 480 秒后重新下载的情况。
期间出现的 `<video>` 只有 B站直播间的 **3 秒静音宣传小挂件**
（`i0.hdslb.com/bfs/live/*.mp4`，1088×368，`muted`，与直播流无关，故意放行）。

### 6.4 切换直播间 / 刷新页面

| 阶段 | 视频元素 | `SourceBuffer` | 直播媒体字节 |
| --- | --- | --- | --- |
| 直播间 A（5440） | 无 | `[]` | 0 |
| 切到直播间 B（22637261） | 无 | `[]` | 0 |
| 刷新直播间 B | 无 | `[]` | 0 |

全过程 **82 个媒体请求全部被拦（100%）**，成功字节 **0**。

### 6.5 开关切换（ON → OFF → ON）

| 阶段 | `SourceBuffer` 追加字节 | 直播 `<video>` | 网络层成功/拦截 |
| --- | --- | --- | --- |
| ON | 0（仅残留 170 KB 旧缓冲） | 无 | 4 / 52 |
| **OFF** | **2,154,278** | **1280×720 播放中** | **60 / 3** |
| ON | **0** | **无** | 4 / 52 |

说明开关在**两个方向**都有真实效果，不是“只能开不能关”。

### 6.6 弹幕与直播间其他功能

开启屏蔽后实测：弹幕 WebSocket **34 个连接**正常建立并保持（长时运行为 60 个），
页面 console 错误 **0**，直播间页面 / 播放器 JS / 头像 / 榜单 / 日志上报请求全部正常放行。

### 6.7 流量估算依据

实测码率（12 秒连续读取真实 FLV 流）：

| 项目 | 数值 |
| --- | --- |
| FLV（avc）实测 | 4,062,628 字节 / 12.01 秒 = **2.707 Mbps ≈ 0.323 MB/s** |
| API `realtime_avg_bw` 报告值 | 203,374 B/s ≈ 1.63 Mbps |

popup 用 **2.7 Mbps** 作估算系数，措辞为“估算节省流量”，不伪装成精确值。

### 6.8 已知问题与风险

| 问题 | 说明 |
| --- | --- |
| ~~**音频无法保留**~~ | V1 的旧结论，**V2 已解决**（纯音频 FLV，见第 0 节）；此处保留仅为记录当时的判断过程。 |
| **播放器会重试一阵** | 拦截后播放器换 CDN 重试（60 秒内约 55 次），随后停止。不下载数据，但会产生短时小请求，理论上可能触发 B站风控。 |
| **仅验证 Edge 154** | 环境只有 Edge；未在 Chrome 上实测（两者同为 Chromium，但未验证不等于已验证）。 |
| **`getMatchedRules` 需开发者模式** | 统计依赖 `declarativeNetRequestFeedback`；上架商店后需更换统计方式。 |
| **B站改版风险** | 若 `/live-bvc/` 路径标记或扩展名变化，需改 `shared/bilibili-signatures.js`（唯一需要改的文件）。 |
| **镜像代理域名不可枚举** | 代理域名为随机 hash，因此不能写死域名，只能依赖路径标记。 |
| **未做 30 分钟整段验证** | 受环境时间限制，长时测试为 10 分钟。建议自行复跑 30 分钟，方法见第 7 节。 |

---

### 6.9 播放中打开开关为什么需要额外处理（已修复）

### 问题

在直播间已经正常播放视频时再打开开关，**画面会继续播放**；只有在进入直播间之前
就打开开关才能拦住。

### 根本原因

`declarativeNetRequest` 的 `block` 是**请求层**的判决：它既不撤销已经发出的请求，
也不拥有页面里的播放对象。

```
<video> 的 currentSrc = blob:https://live.bilibili.com/<uuid>
        ↑ 这个 blob 由页面里的 MediaSource 供给
        ↑ 数据来自播放器自己的 fetch 循环
DNR 拦得住那个 fetch，但拦不到 blob:
画面继续从已经追加进 SourceBuffer 的数据里播放
```

而原来的代码里，开关只做两件事：写 `storage` + 更新 DNR 规则，
**没有任何消息发给页面**。所以“已经建立的播放器”无人拆除。

### 修复方案

分工明确，两层各管一段：

| 层 | 职责 |
| --- | --- |
| `declarativeNetRequest` | 阻止**后续**直播流请求（原有规则，未改动） |
| `content/media-stop.js`（新增） | **终止已经存在的播放对象** |

`media-stop.js` 的做法（不是隐藏画面）：

- 对直播媒体元素 `pause()` + 清空所有取源途径 + `load()`，让元素释放解码器与 MediaSource 缓冲
- 直播间的宣传小挂件是直链 mp4，**用 `blob:` 源判定与直播流区分**，不会被误伤
- 播放器是异步创建、且会自行重建，所以用 `MutationObserver` + 兜底轮询持续保持停止状态

`background/service-worker.js` 增加了一处 `chrome.storage.onChanged` 监听：
**storage 成为开关的唯一事实来源**。此前只有 popup 发来的 `setEnabled` 消息才会写规则，
任何不经该消息的开关变更都不会让规则生效。

### 关闭开关后如何恢复

实测：播放器被拆掉后**不会自行重建播放链路**。因此 `media-stop.js` 在关闭屏蔽时
会检查“是否拆过播放链路且当前没有直播媒体在播放”，满足则刷新页面让播放器干净重建。
未拆过播放链路的页面不会被刷新。

实测结果：关闭后 3~6 秒内恢复播放（多数情况下播放器自行恢复，无需刷新）。

### 本次修复的实测数据

| 步骤 | SourceBuffer 累计字节 | 直播媒元素 |
| --- | --- | --- |
| 播放中（OFF） | 2,283,393 | `paused:false, readyState:4, 640×…` |
| 开启屏蔽 1.5 秒后 | 2,283,393 | **`paused:true, readyState:0, w:0`** |
| 再 120 秒 | **2,283,393（零增长）** | 仍然停止 |
| 关闭屏蔽 3~6 秒后 | 重新增长 | **`paused:false, readyState:4`** |
| 第 2 轮 开启 → 关闭 | 同上，可反复 | 同上，可反复 |

补充的可控验证（屏蔽前后对同一真实 `/live-bvc/` 地址发 `fetch`）：

| 项目 | 结果 |
| --- | --- |
| 屏蔽前 `/live-bvc/` 请求 | `OK status=404`（放行） |
| 屏蔽前对照请求 | `OK status=200` |
| 屏蔽后动态规则数 | `0 → 1` |
| 屏蔽后 `/live-bvc/` 请求 | **`FAILED`（被拦截）** |
| 屏蔽后对照请求 | `OK status=200`（证明探测本身有效） |
| 屏蔽后 SourceBuffer 增长 | **0 字节** |

---

## 6.10 V2.1 体验优化（发布前）

三处改动，均不触碰拦截层（DNR / media-stop / 取流 / 重试）与 V1/V2 已验证行为：

### 1) 播放器遮挡：整块遮罩 → 左上角小徽标

**问题（实测）**：原 `content/overlay.js` 把 `#vlb-overlay` 铺满整个播放器容器
（实测 rect 与 `#player-ctnr` 完全一致：668×428 / 1320×734），`background:rgba(12,14,18,.72)`
且 `z-index:2147483000`，恰好盖住位于播放器底部的 B站原生控制条
（`#web-player-controller-wrap-el` / `#web-player__bottom-bar__container`）。
`pointer-events:none` 只保证点击穿透，不保证可见 —— 音量、播放暂停、刷新、画质、弹幕设置
全部被压暗。

**改动**：`overlay.js` 不再生成整块遮罩，只在播放器左上角（`top:34px; left:10px`，
避开顶部状态挂件、底部控制条、右上“更多设置”）放一个约 20px 高的小徽标。
徽标本身是一个独立组件（不覆盖其它区域），样式放在 `document.head`。

> 后续（V2.1.1）：文字徽标已改成 28×28 圆形按钮并挂到 `document.body`，见第 6.11 节。

### 2) 页面内控制入口

同一个徽标即入口：点击 = 切换省流量模式。状态**只有一个来源** ——
`chrome.storage.local`（`enabled` + `audioStatus.phase`），
点击只写 `enabled`，由 service worker 的 storage 监听同步 DNR 规则，
与 popup 走的是同一条链路，不存在两套状态。

徽标文案与状态：`省流量：关` / `省流量：开 · 音频播放中` /
`省流量：开 · 等待页面交互`（自动播放被拦时）/ `省流量：开 · 音频不可用`。

生命周期：`setInterval(sync, 2000)` + `pageshow`，播放器容器被 B站重建（换布局/换房间）
时跟随移动，并保证页面上始终只有一个徽标。

### 3) 直播首页大屏（live.bilibili.com/）——已移除

曾经的做法：首页大屏不进入 `/<room>` 路径，`readRoomId()` 恒为 null，于是每秒读一次
页面自己的 `window.playerInstance.opts.cid` 并用 `page-room` 消息上报给控制层。

> **V2.2 已整体删除**：该场景受浏览器自动播放策略限制（页面自己的大屏是静音自动播放，
> 拿不到用户手势）、对插件的实际使用价值很低，插件正式定位为「进入具体直播间后才生效」。
> 删除内容与实测见第 6.12 节。

### 4) 顺带修正

`live-state.js` 的 `isLiveRoomPage()` 曾把首页 `/` 也算作“在直播播放页”，
否则 popup 会在首页显示“当前不在直播间”，与插件正在播放音频的事实矛盾。

> **V2.2 已回退**：首页大屏不在支持范围内，该特例随首页大屏支持一起删除（见第 6.12 节）。

### 集中验收实测（2026-10-06，Edge 154 / Chromium 154）

> 注意：`accept-v21.mjs` 用 `--autoplay-policy=no-user-gesture-required` 启动浏览器，
> 因此它**不覆盖**浏览器自动播放策略这一层，相关结论与真实验证见第 6.11 节。

`node tools/accept-v21.mjs`，49 项检查全部通过：

| 项目 | 实测 |
| --- | --- |
| 普通直播间（ON） | 纯音频播放中，`<audio>` 实例 = 1，视频网络 0B、视频解码 0B，弹幕正常 |
| 徽标 vs 原生控制条 | 徽标与 `#web-player-controller-wrap-el` 重叠面积 = 0；播放器底部点击命中 B站元素 |
| 页面入口 / popup | 徽标点击 OFF（DNR 规则 2→0）、popup 链路 ON（0→2），徽标文案同步，全程徽标数 = 1 |
| 房间切换 A→B→C→A | 每段只有 1 个音频、音频持续前进、徽标仍在、视频网络 0B |
| F5 刷新 | 自动恢复播放、徽标恢复、视频 0B / 0 解码 |
| 首页大屏 | 有声音；`engine.roomId == page.cid`；切换后跟随新 room_id、旧音频停止、只有 1 个音频；刷新后恢复；视频网络 0B |
| 两种布局 | 观测到 `top` 与 `top > iframe(blanc/7734200)` 两种；两种下都不重复、都不遮挡 |
| 插件自身 JS 错误 | 0 |

实测中还确认：**插件自身可以拦不到的唯一情况是浏览器缓存命中**
（`requestServedFromCache`，不产生网络请求，DNR 无从拦起，实测 0 字节）；
步骤 B 主动关闭插件期间的 607 KB 视频下载属于关闭后的预期行为，不计入拦截失败。

---

## 6.11 V2.1.1 高可行性修改（自动播放 + 圆形按钮）

改三个文件：`content/audio-page.js`、`content/audio-player.js`、`content/overlay.js`
（另加 `popup/popup.js` 一处文案）。**不触碰** DNR / 取流 / CDN 重试 / media-stop /
房间页播放逻辑；**不实现**任何 B站原生播放器控制同步。

### 1) 先纠正一个此前被掩盖的变量：自动播放策略

第 6.10 节的验收脚本（以及 `cdp-capture` / `scenario-one` / `verify-recovery` 等
共 9 个工具）都传了 `--autoplay-policy=no-user-gesture-required`，
**把浏览器的自动播放策略整体屏蔽掉了**，所以“首页大屏有声音”这件事从未在真实策略下被验证过。

用 Edge 默认策略重测后的实测事实（全新 profile、未登录、直接输入 URL）：

| 实测 | 结果 |
| --- | --- |
| 首页 `playerInstance.opts.cid` → `page-room` → `currentRoomId()` → `resolveAudioStream` → App 纯音频 FLV → MediaSource → mpegts attachMedia → `<audio>` 创建（`readyState=4`、`src=blob:`） | **全部成功** |
| `HTMLMediaElement.play()` | **被拒：`NotAllowedError: play() failed because the user didn't interact with the document first.`** |
| `audio.muted = true` 后再次 `play()` | **仍被拒，同样的 NotAllowedError** |
| 新建的普通 `<audio muted src=dataURI>` 在零手势页面 `play()` | **同样被拒** |
| 页面内一次真实点击后（同一实例）再 `play()` | **成功**，`currentTime` 立刻从已缓冲位置继续 |

也就是说：**断点只有一个，就是 `play()` 本身**；
而**“静音兜底”在这个环境里根本不可行**——该策略对 `<audio>` 连静音播放也一并拦下，
所以不能靠“先静音跑起来”的方案（那样只会留下一个 muted 的假播放状态）。
唯一可行的恢复方式是：页面出现用户手势后，对**同一个实例**再调一次 `play()`。

首页大屏之所以必然踩到这一点：B站首页大屏自己的视频是**静音自动播放**（实测
`muted:true, volume:0.9`），页面永远不会自己产生用户激活；而用户打开插件（点扩展图标）
并不产生页面手势。房间页只是恰好因为用户点过 bilibili（origin 已有激活）才正常。

### 2) 改动

- `audio-page.js`：`play()` 被拒时**不拆链路**，保留同一个 `<audio>` / MediaSource /
  mpegts 实例，只上报 `error{kind:"autoplay"}`；新增 `cmd:"resume"`，只对现有实例再调一次
  `play()` —— **不重新取流、不重建 `<audio>`、不重新初始化播放器**。
- `audio-player.js`：`armGestureRetry()` 在 `document` 捕获阶段监听 `pointerdown` / `keydown`，
  第一次有效手势发 `resume`；**成功播放（`playing` 事件）后才注销监听**，避免手势被白白消耗。
  带 `data-vlb-ui` 的节点（插件自己的按钮与提示）**不算页面手势**，点按钮只开关插件。
- `overlay.js`：文字徽标 → **28×28 圆形按钮**，`position:fixed` 挂 `document.body`，
  坐标每次由播放器容器的 `getBoundingClientRect()` 现算（左上角 +10/+34，避开顶部信息挂件与
  底部控制条），滚动/改窗口用 rAF 跟手。ON=`🔊` 绿色，OFF=`🔇` 灰/低透明，
  等待手势=琥珀色。点击只写 `chrome.storage.local.enabled`（与 popup 完全同一条链路），
  并在按钮正下方显示 2.5 秒提示「省流量模式已开启 / 已关闭」，`pointer-events:none`，
  重复点击重新计时；播放器不存在时自动隐藏，出现即恢复，全页始终只有一个。
- `popup/popup.js`：补 `blocked` 阶段文案（仅新增一行，未改逻辑）。

### 3) 明确不做

B站原生播放器的播放/暂停、音量、静音、播放状态**一律不同步**。实测依据：插件 ON 时
B站播放器已经把 `<video>` 销毁（控制台实测出现 `videoDestroyed===>`，逐帧扫描
`video==0`），`#web-player-controller-wrap-el` 退化成 0 高度 / 0 子节点的空壳，
既没有可读的 DOM 状态也没有可监听的事件；唯一能拿到用户意图的办法是 hook B站播放器内部，
已明确排除。

### 4) 实测（2026-10-06，Edge 154，**默认 autoplay 策略**，未传 `--autoplay-policy`）

当时的脚本 `tools/verify-v21-autoplay.mjs` 56 项全部通过；该脚本已随首页大屏功能一起删除，
由 V2.2 的 `tools/verify-v22-final.mjs` 取代（结果见第 6.12 节）。

> 测量这层时顺序很重要：**首页必须最先跑**（全新 profile、零手势），
> 因为 origin 一旦被点过一次，后续页面的未静音 `play()` 就会直接成功，就测不出被拦与恢复的路径了。

| 场景 | 实测 |
| --- | --- |
| 首页（零手势） | 取流成功、`<audio>` = 1、`readyState=4`；`paused=true`（如实上报 `blocked / 等待页面交互以播放声音`，不伪造播放状态）；视频网络 0B、解码 0B |
| 首页（一次页面手势后） | `play()` 成功、`muted=false`、`currentTime` 0 → 30.9s；**取流次数 2 → 2（未重新取流）、`<audio>` 实例 seq 1 → 1（未重建）**、音频仍只有 1 个 |
| 首页切换推荐直播 | 跟随新 room_id（`cid` → 新房间）、旧音频停止、只剩 1 个音频、视频 0B、按钮仍唯一 |
| 普通直播间 | 音频唯一、`currentTime` / 解码字节持续前进、视频网络 0B / 解码 0B |
| 圆形按钮（房间 / 首页 / blanc） | 存在且唯一、挂 body、`fixed`、28×28、在视口内、命中测试命中自身、不遮挡控制条 |
| 按钮开关 | 点击 → `enabled` 与 DNR 规则同步翻转（2↔0）、popup 状态一致、按钮态 `is-off`↔`is-on` |
| 提示 | 「省流量模式已开启 / 已关闭」出现、`pointer-events:none`、2.5 秒后自动消失、重复点击重新计时 |
| F5（房间 / 首页） | 音频唯一且恢复、按钮恢复且唯一、视频流量 0B、room_id 重新识别 |
| 按钮点击不被当成解锁手势 | 点击按钮后音频未变成静音、未误触发 resume |

回归：`accept-v21.mjs` 49/49（其中 A3/B2/B4 的断言已从“徽标文字”改为“按钮类名”，
因为按钮不再显示文字）；`selfcheck-detector` 167/167、`selfcheck-v2` 78/78、
`selfcheck-serviceworker` 26/26、`selfcheck-mediastop` 26/26、`selfcheck-wiring` 全通过。

### 5) 已知限制（如实记录，不掩盖）

- **没有用户手势时，浏览器会拒绝播放音频**。直接输入直播间 URL、全新 profile 时首次会被拦：
  按钮显示琥珀色、tooltip 写明“点击页面任意处开启声音”，点击页面后立即出声。
  这是浏览器策略，不是插件缺陷。
- 页面首次点击若落在 B站自己 iframe 覆盖的区域（实测 1600×1000 视口下 `(738,838)` 就是
  `iframe`），事件到不了 top 文档，手势解锁不会触发；再点一次即可。

---

## 6.12 V2.2 功能收尾（删除首页大屏支持 + 音量滑块）

功能冻结前的最后一次改动。**不触碰** DNR / App 取流 / 候选主机与 CDN 重试 / MediaSource /
mpegts.js / 主世界播放架构 / 房间识别与切换 / 视频 0B 验证链路。

### 1) 删除「B站直播首页大屏」支持

产品范围收敛为：**只有进入具体直播间才启用插件音频功能**。

| 删除项 | 位置 |
| --- | --- |
| 每秒轮询 `window.playerInstance.opts.cid` | `content/audio-page.js` |
| `page-room` 事件及其 postMessage 上报 | `content/audio-page.js` / `audio-player.js` |
| `pageRoomId` 状态与 `currentRoomId()` 里的“页面自报房间号”回退 | `content/audio-player.js` |
| `live-state.js` 里“首页 `/` 算在直播播放页”的特例 | `content/live-state.js` |
| 首页大屏验收段（E 段，12 项） | `tools/accept-v21.mjs`（49→37 项） |

房间号现在**只有 URL 一个来源**：`/^\/(?:blanc\/)?\d+/`。
插件 UI（圆形按钮 + 音量滑块）也只在直播间路径下显示，首页大屏不再出现任何插件 UI。
首页仍按全局 DNR 规则拦截视频媒体请求（DNR 是按 URL 匹配的全局规则，未做改动）。

### 2) 音量滑块

圆形按钮右侧新增 `input[type="range"]`（0~100，默认 100），样式为同色胶囊轨道：

```text
[🔊] [────●──]
```

- 只改**插件自己的** `<audio>.volume` 并写 `chrome.storage.local.volume`（0~1）；
  不碰 B站原生播放器、不触发开关、不重新取流、不重建 MediaSource / mpegts。
- 主世界拿不到 `chrome.storage`，所以音量由隔离世界随 `play` 指令带过去，
  元素创建时就按保存值设置：`el.volume = volume`（缺省 1）。
- 显示条件：**插件开启 且 插件 `<audio>` 已存在**；关闭插件或离开房间即收起。
- 音量为 0 时按钮图标变 🔇（只是视觉反馈，**静音 ≠ 关闭插件**，状态类名仍是 `is-on`）。
- 滑块带 `data-vlb-ui`，与按钮同一套规则：**不被识别为页面手势**，也不把事件传给 B站播放器。

改动文件：`content/overlay.js`（滑块 + 图标）、`content/audio-page.js`（创建元素时设置音量）、
`content/audio-player.js`（读取并随指令传递音量）。

### 3) 实测（2026-10-06，Edge 154，**默认 autoplay 策略**）

`node tools/verify-v22-final.mjs 9561 "C:\Users\how\Desktop\chajian\extension" 6` —— **56 项全部通过**
（日志 `tools/verify-v22-final.log`）：

| 场景 | 实测 |
| --- | --- |
| 普通直播间 | 纯音频播放、`<audio>`=1、视频网络 0B、按钮 + 滑块都在、滑块默认 100 |
| 音量 | 拖到 24 → `audio.volume=0.24` 且 `storage.volume=0.24`；拖到 0 → `volume=0`、图标 🔇、插件仍是开启态、音频仍在播放；调回 80 → `volume=0.8`、图标 🔊；全程未重新取流、未重建播放器 |
| ON/OFF | 关闭后 `<audio>` 移除、滑块立即收起、`storage.volume` 保持 0.8；重新开启后音频按 0.8 播放、滑块回到 80 |
| 房间切换 A→B→C→A（6 / 7734200 / 545068） | 每段 `<audio>` ≤1 且唯一、音量保持 0.8、视频网络 0B、按钮与滑块都在 |
| F5 刷新 | 音频恢复且唯一、音量保持 0.8、按钮与滑块恢复、视频流量 0B |
| `/blanc/6` | 房间识别正确、音频唯一、同一套按钮与滑块、音量保持 |
| **首页 `live.bilibili.com/`** | **不创建插件 `<audio>`、不显示按钮、不显示滑块、不取流（取流次数 0）**、状态为“当前不是直播间页面”、`liveSnapshot.isLiveRoomPage=false` |

回归：`accept-v21.mjs` 37/37（首页段已删除，故由 49 项变为 37 项）；
`selfcheck-detector` 167/167、`selfcheck-v2` 78/78、`selfcheck-serviceworker` 26/26、
`selfcheck-mediastop` 26/26、`selfcheck-wiring` 全通过。

### 4) 已知限制

- 首页大屏**没有**插件声音与插件 UI，这是产品范围决定的，不是缺陷。
- 音量为 0 时主世界仍在播放（只是没声音），因此不会触发重连；这是刻意的：
  静音是用户选择，不是流故障。
- 拖音量滑块虽然会给页面带来用户激活，但按需求它**不算**解锁手势（不会被用来恢复播放），
  自动播放被拦时仍需点一下页面其他位置。

---

## 7. 验证方法与复跑

```bash
# 判决逻辑 / DNR 规则 / manifest 自检（无需浏览器，167 项检查）
node tools/selfcheck-detector.mjs

# V2.1 发布前集中验收（真实浏览器，一次跑完 A~D、F，37 项检查）
# 注意：该脚本传了 --autoplay-policy=no-user-gesture-required，不覆盖自动播放策略
node tools/accept-v21.mjs 9530 "C:\...\extension"

# V2.2 收尾验证：纯音频 + 圆形按钮 + 音量滑块 + 首页已移出范围
# （**默认 autoplay 策略**，56 项检查；房间切换段需要至少 2 个正在直播的房间）
node tools/verify-v22-final.mjs 9561 "C:\...\extension" 6

# 接线一致性检查（popup <-> service worker <-> manifest 引用）
node tools/selfcheck-wiring.mjs

# media-stop 单元自检（无需浏览器，26 项：终止播放、不误伤挂件、关闭后恢复刷新）
node tools/selfcheck-mediastop.mjs

# service worker 单元自检（16 项：storage 变更驱动 DNR 规则、消息协议）
node tools/selfcheck-serviceworker.mjs

# 拉取真实直播流信息
node tools/stream-info-probe.mjs 5440

# 穷举 playurl 参数，确认是否存在纯音频流
node tools/audio-only-probe.mjs 5440

# 实测真实码率
node tools/measure-bitrate.mjs 5440 12

# 启动遥测收集器（插件会自动读取它的开关状态）
node tools/collector.mjs 8791 enabled tools/telemetry.json all

# 真实浏览器采集：房间号 秒数 标签 扩展目录 开关 策略 采样间隔(ms)
node tools/cdp-capture.mjs 5440 1800 long "C:\...\extension" on all 30000

# 单场景验证（每次全新启动，执行环境稳定）
#   参数：房间 模式 端口 扩展目录 预热profile 观察秒数
#   模式：on = 屏蔽 ON 进入直播间；offon = 播放中开启；offonoff = 再关闭验证恢复
node tools/scenario-one.mjs 5440 on     9471 "C:\...\extension" temp
node tools/scenario-one.mjs 5440 offon  9472 "C:\...\extension" temp 120
node tools/scenario-one.mjs 6    on     9473 "C:\...\extension" temp

# 开关双向验证（开启停止 + 关闭恢复，可反复两轮）
node tools/verify-recovery.mjs 5440 9480 "C:\...\extension" temp 45

# 拦截效果的可控验证（屏蔽前后对同一真实地址发 fetch）
node tools/verify-network-block.mjs 5440 9481 "C:\...\extension" temp 15
```

**重要**：`--user-data-dir` 必须是本次启动独占的目录。若已有 Edge 进程持有同一个
profile，新启动的进程只会开个新窗口并**忽略 `--load-extension`**，扩展根本不会加载。
上面的脚本都使用全新临时目录（或从预热 profile 复制一份），因此不受影响。

复跑 30 分钟长时测试：把 `cdp-capture.mjs` 的秒数改为 `1800`，
并把 `COLLECTOR_LIFETIME_MS` 设为大于 1800000。

URL 上的 `?vlb=on|off&vlbblock=manifest|segments|all` 是自动化测试入口，
正常使用只需点 popup 开关。

---

## 8. 明确不做（范围外，功能已冻结）

- **B站直播首页大屏**（`live.bilibili.com/`）：不建立插件音频，不显示插件 UI（V2.2 起移出范围）。
- **B站原生播放器控制**：不同步播放/暂停、音量、静音、播放状态；
  **不 hook** B站内部播放器实例、内部事件、内部控制条逻辑。
  实测依据：插件 ON 时 B站播放器已把 `<video>` 销毁（控制台出现 `videoDestroyed===>`，
  逐帧扫描 `video==0`），`#web-player-controller-wrap-el` 退化成 0 高度 / 0 子节点的空壳，
  没有可读的 DOM 状态与可监听事件面。
- **绕过自动播放策略**：不尝试 muted autoplay hack（实测该策略对 `<audio>` 连静音播放也一并拦下）。
- **弹幕发送结果检测**。
- 自己实现弹幕 / 直播播放器、登录系统、后端、数据库、云服务、用户账号、自动模式。

> 项目自 V2.2 起进入冻结状态：不再新增功能，只修缺陷。
