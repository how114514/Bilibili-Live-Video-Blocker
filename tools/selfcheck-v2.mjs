// V2 静态自检：不启动浏览器，只检查代码本身是否自洽。
//
//   node tools/selfcheck-v2.mjs
//
// 覆盖：
//   1. extension 下所有 JS 的语法
//   2. manifest.json 结构 + 它引用的每个文件是否真的存在
//   3. V2 纯音频纯函数的单元测试（用真实抓到的 URL 做夹具）
//   4. DNR 放行规则能否区分 App 纯音频流与 Web 播放器复用流
//
// 第 4 项是 V2 最容易出事的地方：两种 URL 路径形状完全相同，
// 一旦正则写错，要么放行视频、要么拦死自己的音频。这里用真实 URL 夹具钉住它。

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");

let failures = 0;
let checks = 0;

function ok(name, extra = "") {
  checks++;
  console.log(`  PASS  ${name}${extra ? `  ${extra}` : ""}`);
}

function fail(name, detail) {
  checks++;
  failures++;
  console.log(`  FAIL  ${name}\n        ${detail}`);
}

function assert(condition, name, detail) {
  if (condition) ok(name);
  else fail(name, detail);
}

// ------------------------------------------------------------ 1. 语法检查

console.log("\n[1] JS 语法");

/** ESM 的 .js 用 node --check 会按 CommonJS 解析，复制成 .mjs 再检查。 */
function syntaxCheck(file, isModule) {
  const abs = join(EXT, file);
  if (!existsSync(abs)) return fail(`语法 ${file}`, "文件不存在");
  const tmp = mkdtempSync(join(tmpdir(), "vlb-check-"));
  try {
    const target = join(tmp, isModule ? "check.mjs" : "check.js");
    writeFileSync(target, readFileSync(abs));
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
    ok(`语法 ${file}`);
  } catch (error) {
    fail(`语法 ${file}`, String(error.stderr ?? error.message).split("\n").slice(0, 4).join("\n        "));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const CLASSIC = [
  "content/hook-injector.js",
  "content/media-stop.js",
  "content/live-state.js",
  "content/overlay.js",
  "content/audio-player.js",
  "content/audio-page.js",
  "content/page-probe.js",
  "content/probe-reporter.js",
  "popup/popup.js",
];
const MODULES = ["shared/bilibili-signatures.js", "background/service-worker.js", "detector/video-request-detector.js"];

for (const file of CLASSIC) syntaxCheck(file, false);
for (const file of MODULES) syntaxCheck(file, true);
syntaxCheck("vendor/mpegts.min.js", false);

// --------------------------------------------------------- 2. manifest 完整性

console.log("\n[2] manifest.json");

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  ok("manifest.json 可解析");
} catch (error) {
  fail("manifest.json 可解析", String(error.message));
}

if (manifest) {
  assert(manifest.manifest_version === 3, "manifest_version = 3", `实际 ${manifest.manifest_version}`);

  const referenced = [];
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) referenced.push(js);
  }
  for (const rule of manifest.declarative_net_request?.rule_resources ?? []) referenced.push(rule.path);
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) referenced.push(resource);
  }
  if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);

  for (const rel of referenced) {
    assert(existsSync(join(EXT, rel)), `引用存在 ${rel}`, "manifest 引用了不存在的文件");
  }

  // V2 的实际播放跑在主世界，由 hook-injector.js 注入。
  // mpegts 必须先于 audio-page.js 执行，且两者都要能被页面加载。
  const injector = readFileSync(join(EXT, "content/hook-injector.js"), "utf8");
  const injected = [...injector.matchAll(/"(content\/[\w.-]+\.js|vendor\/[\w.-]+\.js)"/g)].map((m) => m[1]);
  const mpegtsAt = injected.findIndex((f) => f.includes("mpegts"));
  const pageAt = injected.findIndex((f) => f.includes("audio-page.js"));
  assert(
    mpegtsAt >= 0 && pageAt > mpegtsAt,
    "hook-injector 里 mpegts.min.js 排在 audio-page.js 之前",
    `实际顺序 ${JSON.stringify(injected)}`,
  );

  const war = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
  for (const file of injected) {
    assert(war.includes(file), `注入的文件在 web_accessible_resources 里：${file}`, `实际 ${JSON.stringify(war)}`);
  }

  const hasAudioEntry = (manifest.content_scripts ?? []).some((entry) =>
    (entry.js ?? []).some((js) => js.includes("audio-player.js")),
  );
  assert(hasAudioEntry, "存在 audio-player 内容脚本", "manifest 里找不到 audio-player.js");

  const hosts = manifest.host_permissions ?? [];
  assert(
    hosts.some((h) => h.includes("api.live.bilibili.com")),
    "host_permissions 含 api.live.bilibili.com",
    `实际 ${JSON.stringify(hosts)}`,
  );
}

// -------------------------------------------------------- 3. 纯函数单元测试

console.log("\n[3] V2 纯函数");

const sig = await import(new URL("../extension/shared/bilibili-signatures.js", import.meta.url));

// --- 房间号
const roomCases = [
  ["/6", "6"],
  ["/7734200", "7734200"],
  ["/blanc/22637239", "22637239"],
  ["/6/", "6"],
  ["/p/eden/area-tags", null],
  ["/", null],
  ["/6/whatever", "6"],
];
for (const [pathname, expected] of roomCases) {
  const actual = sig.parseLiveRoomId(pathname);
  assert(actual === expected, `parseLiveRoomId("${pathname}") === ${JSON.stringify(expected)}`, `实际 ${JSON.stringify(actual)}`);
}

// --- 取流地址
const built = sig.buildAudioOnlyPlayInfoUrl("6", 1791213000);
assert(built.startsWith(sig.APP_ROOM_PLAYINFO_API + "?"), "取流地址指向 app-room 接口", built);
assert(built.includes("only_audio=1"), "取流地址带 only_audio=1", built);
assert(built.includes("room_id=6") && built.includes("ts=1791213000"), "取流地址带 room_id 与 ts", built);
assert(!built.includes("pt=web"), "取流地址不含 Web 播放器标记", built);

// --- 挑流：只认 http_stream/flv
const webRoomShaped = {
  data: {
    playurl_info: {
      playurl: {
        stream: [
          { protocol_name: "http_hls", format: [{ format_name: "fmp4", codec: [{ base_url: "/x/", url_info: [{ host: "https://cdn.example", extra: "?a=1" }] }] }] },
          { protocol_name: "http_stream", format: [{ format_name: "flv", codec: [{ base_url: "/live-bvc/1/a_2500.flv?", url_info: [{ host: "https://cdn.example", extra: "expires=1791216913&pt=android" }], session: "s1" }] }] },
        ],
      },
    },
  },
};
const picked = sig.pickAudioOnlyStream(webRoomShaped);
assert(picked?.url === "https://cdn.example/live-bvc/1/a_2500.flv?expires=1791216913&pt=android", "挑出 http_stream/flv", JSON.stringify(picked));
assert(picked?.expiresAt === 1791216913, "解析出 expires", String(picked?.expiresAt));
assert(picked?.session === "s1", "带出 session", String(picked?.session));

assert(sig.pickAudioOnlyStream({ data: { playurl_info: { playurl: { stream: [] } } } }) === null, "没有流时返回 null", "非 null");
assert(sig.pickAudioOnlyStream({}) === null, "响应为空时返回 null", "非 null");
assert(
  sig.pickAudioOnlyStream({ data: { playurl_info: { playurl: { stream: [{ protocol_name: "http_stream", format: [{ format_name: "flv", codec: [] }] }] } } } }) === null,
  "codec 为空时返回 null",
  "非 null",
);

// 优先 https 主机（CDN 有时只给 http://，页面是 https 会被 mixed content 拦掉）
const httpHostOnly = {
  data: {
    playurl_info: {
      playurl: {
        stream: [{ protocol_name: "http_stream", format: [{ format_name: "flv", codec: [{ base_url: "/live-bvc/1/a.flv?", url_info: [{ host: "http://cdn.example", extra: "pt=android" }] }] }] }],
      },
    },
  },
};
assert(
  sig.pickAudioOnlyStream(httpHostOnly)?.url.startsWith("https://"),
  "http 主机被升级为 https",
  sig.pickAudioOnlyStream(httpHostOnly)?.url,
);

// 多主机：http 排前、https 排后时，https 必须被排到第一位
const multiHost = {
  data: {
    playurl_info: {
      playurl: {
        stream: [{ protocol_name: "http_stream", format: [{ format_name: "flv", codec: [{ base_url: "/live-bvc/1/a.flv?", url_info: [
          { host: "http://plain.example", extra: "pt=android&mark=1" },
          { host: "https://secure.example", extra: "pt=android&mark=2" },
          { host: "https://second.example", extra: "pt=android&mark=3" },
        ] }] }] }],
      },
    },
  },
};
const multi = sig.pickAudioOnlyStream(multiHost);
assert(multi?.url === "https://secure.example/live-bvc/1/a.flv?pt=android&mark=2", "https 主机排在第一位", String(multi?.url));
assert(multi?.urls?.length === 3, "返回全部候选主机（用于 403 时换节点）", JSON.stringify(multi?.urls));
assert(multi?.urls?.[0] === multi?.url, "url 与 urls[0] 一致", JSON.stringify(multi?.urls));
assert(
  multi?.urls?.every((u) => u.startsWith("https://")),
  "候选主机全部升级为 https",
  JSON.stringify(multi?.urls),
);

// --- expires
assert(sig.parseStreamExpiry("https://x/live-bvc/1/a.flv?expires=1791216913&pt=android") === 1791216913, "parseStreamExpiry 正常", "不符");
assert(sig.parseStreamExpiry("https://x/live-bvc/1/a.flv") === null, "parseStreamExpiry 无参数返回 null", "不符");

// ------------------------------------- 4. DNR 正则：区分 App 与 Web（关键）

console.log("\n[4] DNR 放行规则区分度");

// 真实抓取到的 URL 形状（2026-10-05/06，room 6）
const APP_FLV =
  "https://d1--cn-gotcha07.bilivideo.com/live-bvc/896936/live_50329118_9516950_2500.flv?expires=1791217638&pt=android&deadline=1791217638&len=0&oi=0x240e047c068080296409c1cf205a9db3&platform=android&qn=250&trid=10005e27b314fd3dc72861ae5848746ac3c1&uipk=100&uipv=100&nbs=1&bmt=2&uparams=cdn,deadline,len,oi,platform,qn,trid,uipk,uipv,nbs,bmt&cdn=cn-gotcha01&upsig=79aa55c779e82263e9324bd9ae1ad738&ptype=1&site=af320b3f0be49a9dcc83be2308e6298f&free_type=0&mid=0";
const WEB_FLV =
  "https://d1--cn-gotcha04.bilivideo.com/live-bvc/562456/live_50329118_9516950_2500.flv?expires=1791216913&len=0&oi=0x240e047c068080296409c1cf205a9db3&pt=web&qn=250&trid=1000718110f323a1df3d3ba0f9db956ac3bf&bmt=2&sigparams=cdn,expires,len,oi,pt,qn,trid,bmt&cdn=cn-gotcha04&sign=85fc4aeba9eea0820cc31e4fc40d785b&site=33959b2bfb40777bc32e22223949f7da&free_type=0&mid=0";
const WEB_M3U8 =
  "https://d1--cn-gotcha104.bilivideo.com/live-bvc/200727/live_50329118_9516950_2500.m3u8?expires=1791216915&len=0&oi=0x240e&pt=web&qn=250&trid=abc&cdn=cn-gotcha104&sign=deadbeef";
const WEB_M4S =
  "https://d1--cn-gotcha208.bilivideo.com/live-bvc/712607/live_50329118_9516950_2500/323987724.m4s?expires=1791216915&oi=0x240e&pt=web&trid=abc&cdn=cn-gotcha208&sign=deadbeef";
const WEB_TS =
  "https://d1--cn-gotcha104.bilivideo.com/live-bvc/200727/live_50329118_9516950_2500-1791213326.ts?expires=1791216915&oi=0x240e&pt=web&trid=abc&cdn=cn-gotcha104&sign=deadbeef";
// 镜像代理路径：任意代理域名 + 原始 CDN 域名 + /live-bvc/
const MIRROR_WEB_FLV =
  "https://a5fc91355286fb2e8dc224adc9bc5e15.h2.smtcdns.net/d1--cn-gotcha204b.bilivideo.com/live-bvc/1/live_a_2500.flv?expires=1&pt=web&cdn=x&sign=y";

const allowRe = new RegExp(sig.AUDIO_ALLOW_REGEX);
const blockRe = new RegExp(sig.BLOCK_MODE_REGEX[sig.BLOCK_MODES.ALL]);

const allowCases = [
  ["App 纯音频 FLV 被放行", APP_FLV, true],
  ["Web 播放器 FLV 不被放行", WEB_FLV, false],
  ["Web m3u8 不被放行", WEB_M3U8, false],
  ["Web m4s 不被放行", WEB_M4S, false],
  ["Web ts 不被放行", WEB_TS, false],
  ["镜像代理的 Web FLV 不被放行", MIRROR_WEB_FLV, false],
];
for (const [name, url, expected] of allowCases) {
  const actual = allowRe.test(url);
  assert(actual === expected, name, `期望 ${expected} 实际 ${actual}`);
}

const blockCases = [
  ["App 纯音频 FLV 仍会被拦（需靠放行规则救）", APP_FLV, true],
  ["Web FLV 被拦", WEB_FLV, true],
  ["Web m3u8 被拦", WEB_M3U8, true],
  ["Web m4s 被拦", WEB_M4S, true],
  ["Web ts 被拦", WEB_TS, true],
  ["镜像代理 Web FLV 被拦", MIRROR_WEB_FLV, true],
];
for (const [name, url, expected] of blockCases) {
  const actual = blockRe.test(url);
  assert(actual === expected, name, `期望 ${expected} 实际 ${actual}`);
}

// 两条规则合起来的效果：只有 App 纯音频能过。
console.log("\n[4b] 规则叠加后的最终效果（allow 优先级 2 > block 优先级 1）");
for (const [name, url] of [["App 纯音频 FLV", APP_FLV], ["Web FLV", WEB_FLV], ["Web m3u8", WEB_M3U8], ["Web m4s", WEB_M4S], ["Web ts", WEB_TS], ["镜像代理 Web FLV", MIRROR_WEB_FLV]]) {
  const blocked = blockRe.test(url);
  const allowed = allowRe.test(url);
  const final = blocked && !allowed ? "阻止" : "放行";
  const expected = url === APP_FLV ? "放行" : "阻止";
  assert(final === expected, `${name} → ${final}`, `期望 ${expected}`);
}

// --- isAudioOnlyStreamUrl 与正则保持一致
assert(sig.isAudioOnlyStreamUrl(APP_FLV) === true, "isAudioOnlyStreamUrl(App) === true", "不符");
assert(sig.isAudioOnlyStreamUrl(WEB_FLV) === false, "isAudioOnlyStreamUrl(Web) === false", "不符");
assert(sig.isAudioOnlyStreamUrl(WEB_M3U8) === false, "isAudioOnlyStreamUrl(m3u8) === false", "不符");

// ---------------------------------------------------------------- 汇总

console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
