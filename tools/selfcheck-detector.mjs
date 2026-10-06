/**
 * 自检：把 extension/ 里的判决逻辑、DNR 规则，与真实抓到的 URL 对拍。
 *
 * 覆盖：
 *   1. isLiveMediaUrl() 的判决
 *   2. DNR regexFilter（三种策略）的判决，必须与 detector 一致
 *   3. rules/video-rules.json 与 manifest 的一致性
 *
 * URL 来源：本目录下真实抓取的结果（streaminfo / media-probe / 浏览器实测）。
 * 运行：node tools/selfcheck-detector.mjs
 */
import { readFileSync } from "node:fs";

const {
  isLiveMediaUrl,
  explainLiveMediaUrl,
  LIVE_MEDIA_URL_REGEX = undefined,
  BLOCK_MODES,
  BLOCK_MODE_REGEX,
} = await import("../extension/shared/bilibili-signatures.js");
const { VideoRequestDetector } = await import("../extension/detector/video-request-detector.js");

// ---------------------------------------------------------------- 真实直播流 URL
const shouldBlock = [];

const raw = JSON.parse(readFileSync("tools/streaminfo-raw.json", "utf8"));
const info = raw[0].json.data.playurl_info.playurl;
for (const s of info.stream) {
  for (const f of s.format ?? []) {
    for (const c of f.codec ?? []) {
      const u = (c.url_info ?? [])[0];
      if (u) shouldBlock.push({ url: u.host + c.base_url + u.extra, what: `${s.protocol_name}/${f.format_name}/${c.codec_name}` });
    }
  }
}

const mediaProbe = JSON.parse(readFileSync("tools/media-probe.json", "utf8"));
const fmp4 = mediaProbe.find((r) => r.kind === "manifest" && r.fmt === "fmp4");
if (fmp4) {
  for (const seg of [fmp4.body.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1], ...(fmp4.body.match(/^\d+\.m4s$/gm) ?? []).slice(0, 3)]) {
    if (seg) shouldBlock.push({ url: `https://d1--cn-gotcha209.bilivideo.com/live-bvc/149325/x/${seg}?expires=1`, what: "fmp4 分片" });
  }
}
const tsManifest = mediaProbe.find((r) => r.kind === "manifest" && r.fmt === "ts");
if (tsManifest) {
  for (const seg of (tsManifest.body.match(/^live_\S+-\d+\.ts$/gm) ?? []).slice(0, 3)) {
    shouldBlock.push({ url: `https://d1--cn-gotcha104.bilivideo.com/live-bvc/733592/${seg}?expires=1`, what: "ts 分片" });
  }
}

// 实测遇到的镜像代理形态——这正是最初漏掉、导致视频照常播放的路径。
shouldBlock.push({
  url: "https://a5fc91355286fb2e8dc224adc9bc5e15.h2.smtcdns.net/d1--cn-gotcha204b.bilivideo.com/live-bvc/767940/live_5q503_SXFyrSQ_do4l6_av1/523980440.m4s?expires=1791209642",
  what: "镜像代理 fMP4 分片（实测曾漏拦）",
});
shouldBlock.push({
  url: "https://a5fc91355286fb2e8dc224adc9bc5e15.h2.smtcdns.net/d1--cn-gotcha204b.bilivideo.com/live-bvc/767940/live_5q503_SXFyrSQ_do4l6_av1/index.m3u8?expires=1791209642",
  what: "镜像代理 HLS 清单",
});
shouldBlock.push({
  url: "https://a5fc91355286fb2e8dc224adc9bc5e15.h2.smtcdns.net/d1--cn-gotcha204b.bilivideo.com/live-bvc/767940/live_5q503_SXFyrSQ_do4l6_av1/523980434.ts?expires=1",
  what: "镜像代理 TS 分片",
});

// ---------------------------------------------------------------- 必须放行
const shouldAllow = [
  { url: "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=5440", what: "playurl API" },
  { url: "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=5440", what: "房间信息 API" },
  { url: "https://api.live.bilibili.com/xlive/general-interface/v1/rank/queryContributionRank?room_id=5440", what: "礼物/榜单 API" },
  { url: "https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=5440", what: "弹幕历史 API" },
  { url: "https://broadcastlv.chat.bilibili.com/sub", what: "弹幕 WebSocket 地址" },
  { url: "https://zj-cn-live-comet.chat.bilibili.com:2245/sub", what: "弹幕 WebSocket 地址(备用)" },
  { url: "https://i0.hdslb.com/bfs/face/member/noface.jpg", what: "头像" },
  { url: "https://s1.hdslb.com/bfs/static/bilibili-live-player/room-player.01626800.prod.min.js", what: "播放器 JS" },
  { url: "https://data.bilibili.com/v2/log/web?content=xxx", what: "日志上报" },
  { url: "https://data.bilivideo.com/log/web/te9Kl?w_rid=abc", what: "bilivideo 日志（非 /live-bvc/）" },
  { url: "https://i0.hdslb.com/bfs/live/b4bde0e6fea2d7f4aa03172b4164ae6aba96ab1a.mp4", what: "直播小挂件 mp4（非 /live-bvc/）" },
  { url: "https://cn-hbyc-cu-01-03.bilivideo.com/upgcxcode/12/34/video.m4s?expires=1", what: "普通点播视频（非直播路径）" },
  { url: "https://live.bilibili.com/5440", what: "直播间页面" },
  { url: "https://api.bilibili.com/x/web-interface/nav", what: "登录态 API" },
];

// ---------------------------------------------------------------- 对拍
const detector = new VideoRequestDetector({ enabled: true, blockMode: BLOCK_MODES.ALL });
const detectorManifestOnly = new VideoRequestDetector({ enabled: true, blockMode: BLOCK_MODES.MANIFEST });
const detectorSegmentsOnly = new VideoRequestDetector({ enabled: true, blockMode: BLOCK_MODES.SEGMENTS });
const disabled = new VideoRequestDetector({ enabled: false });
const regexAll = new RegExp(BLOCK_MODE_REGEX[BLOCK_MODES.ALL]);

let checks = 0;
let failures = 0;
const record = (ok, label, extra = "") => {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ""}`);
  }
};

console.log(`== 必须阻止的真实直播流 URL：${shouldBlock.length} 条 ==`);
for (const c of shouldBlock) {
  const js = isLiveMediaUrl(c.url);
  const dnr = regexAll.test(c.url);
  record(js, `detector 漏判: ${c.what}`, c.url.slice(0, 140));
  record(dnr, `DNR 正则漏判: ${c.what}`, c.url.slice(0, 140));
  record(detector.shouldBlock(c.url).block, `shouldBlock=false: ${c.what}`, c.url.slice(0, 140));
  record(js === dnr, `detector 与 DNR 不一致: ${c.what}`, c.url.slice(0, 140));
}
const mirror = shouldBlock.find((c) => c.what.includes("镜像代理"));
console.log(`   镜像代理样例: ${JSON.stringify(explainLiveMediaUrl(mirror.url))}`);

console.log(`\n== 必须放行的正常功能 URL：${shouldAllow.length} 条 ==`);
for (const c of shouldAllow) {
  record(!isLiveMediaUrl(c.url), `detector 误拦: ${c.what}`, c.url.slice(0, 140));
  record(!regexAll.test(c.url), `DNR 误拦: ${c.what}`, c.url.slice(0, 140));
  record(!detector.shouldBlock(c.url).block, `shouldBlock 误拦: ${c.what}`, c.url.slice(0, 140));
}

console.log("\n== 关闭状态必须全部放行 ==\n");
for (const c of shouldBlock.slice(0, 5)) {
  record(disabled.shouldBlock(c.url).block === false, "关闭状态下仍然阻止", c.url.slice(0, 100));
}

console.log("== 策略区分：manifest 只拦清单，segments 只拦分片 ==\n");
for (const c of shouldBlock) {
  const isManifest = new URL(c.url).pathname.toLowerCase().endsWith(".m3u8");
  const m = detectorManifestOnly.shouldBlock(c.url).block;
  const s = detectorSegmentsOnly.shouldBlock(c.url).block;
  record(m === isManifest, `manifest 策略判断错误: ${c.what} (期望 ${isManifest}, 得到 ${m})`);
  record(s === !isManifest, `segments 策略判断错误: ${c.what}`);
  record(m !== s, `两种策略对同一条 URL 结果相同: ${c.what}`);
}
for (const mode of Object.keys(BLOCK_MODE_REGEX)) {
  try {
    new RegExp(BLOCK_MODE_REGEX[mode]);
  } catch (error) {
    record(false, `策略 ${mode} 的正则无法编译`, error.message);
  }
}

console.log("== 规则文件与 manifest 一致性 ==\n");
const ruleset = JSON.parse(readFileSync("extension/rules/video-rules.json", "utf8"));
console.log(`  静态规则条数: ${ruleset.length}`);
record(ruleset.length > 0, "规则文件为空");
for (const r of ruleset) {
  record(r.action?.type === "block", `规则 ${r.id} 不是 block`);
  record(Number.isInteger(r.id) && r.id > 0, `规则 ${r.id} id 非法`);
  record(Array.isArray(r.condition?.resourceTypes) && r.condition.resourceTypes.length > 0, `规则 ${r.id} 缺少 resourceTypes`);
  if (r.condition?.regexFilter) {
    record(
      r.condition.regexFilter === BLOCK_MODE_REGEX[BLOCK_MODES.ALL],
      `规则 ${r.id} 的正则与 BLOCK_MODE_REGEX.all 不一致`,
      `${r.condition.regexFilter}\n        ${BLOCK_MODE_REGEX[BLOCK_MODES.ALL]}`,
    );
  }
}

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
record(manifest.manifest_version === 3, "不是 MV3");
record(Boolean(manifest.permissions?.includes("declarativeNetRequest")), "缺少 declarativeNetRequest 权限");
record(
  manifest.declarative_net_request?.rule_resources?.[0]?.path === "rules/video-rules.json",
  "静态规则路径与文件不一致",
);
for (const path of [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  manifest.action?.default_popup,
]) {
  if (!path) continue;
  try {
    readFileSync(`extension/${path}`);
  } catch {
    record(false, `manifest 引用了不存在的文件: ${path}`);
  }
}

console.log("\n================================");
console.log(`检查项: ${checks}  失败: ${failures}`);
console.log(failures === 0 ? "结果: 全部通过" : "结果: 存在失败项");
process.exit(failures === 0 ? 0 : 1);
