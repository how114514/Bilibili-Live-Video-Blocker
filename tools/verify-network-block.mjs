// Direct proof of DNR blocking on a page where playback is already stopped.
//
// Method (no dependence on the player's internals):
//   1. Start with blocking ON and the player already stopped.
//   2. In the page, attempt a fetch() of a REAL /live-bvc/ URL  -> must FAIL (blocked).
//   3. In the page, attempt a fetch() of a non-live URL         -> must SUCCEED (control).
// This isolates the DNR decision from the player's behaviour.
//
// Then, to prove the end-to-end effect on a *playing* page, we do the mirror image:
//   a page loaded with blocking OFF is playing, we enable blocking, and we verify
//   (a) the video is stopped and (b) a live-bvc fetch is now blocked.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ROOM = process.argv[2] || "5440";
const PORT = Number(process.argv[3] || 9435);
const EXT_DIR = process.argv[4] || "C:\\Users\\how\\Desktop\\chajian\\extension";
const SEED = process.argv[5] || "temp";
const WATCH_S = Number(process.argv[6] || 15);

let profile;
if (SEED === "temp") profile = mkdtempSync(join(tmpdir(), "edge-proof-"));
else {
  profile = mkdtempSync(join(tmpdir(), `edge-proof-${basename(SEED)}-`));
  cpSync(SEED, profile, { recursive: true, force: true });
  for (const l of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { rmSync(join(profile, l), { force: true }); } catch {}
  }
}
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  `--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`,
  `https://live.bilibili.com/${ROOM}?vlb=off&vlbblock=all`,
], { stdio: "ignore" });

let ws = null, msgId = 0;
const pending = new Map();
const events = [];
function send(method, params = {}, sessionId, timeoutMs = 12000) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  const key = `${sessionId ?? ""}#${id}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(key); resolve({ __timeout: true }); }, timeoutMs);
    pending.set(key, (v) => { clearTimeout(t); resolve(v); });
  });
}

let version = null;
for (let i = 0; i < 40 && !version; i++) {
  await sleep(1000);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
}
if (!version) { log("no endpoint"); process.exit(1); }
ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => { ws.addEventListener("open", r); ws.addEventListener("error", r); });
ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(`${m.sessionId ?? ""}#${m.id}`)) {
    const k = `${m.sessionId ?? ""}#${m.id}`;
    pending.get(k)(m.result ?? m.error ?? {});
    pending.delete(k);
    return;
  }
  if (m.method) events.push(m);
});

let swSession = null, pageSession = null;
for (let i = 0; i < 30; i++) {
  const list = (await send("Target.getTargets", {})).targetInfos ?? [];
  const sw = list.find((x) => x.type === "service_worker" && /background\/service-worker\.js/.test(x.url));
  const pg = list.find((x) => x.type === "page" && x.url.includes("live.bilibili.com"));
  if (sw && pg) {
    swSession = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
    pageSession = (await send("Target.attachToTarget", { targetId: pg.targetId, flatten: true })).sessionId;
    break;
  }
  await sleep(1000);
}
if (!pageSession) { log("no targets"); process.exit(1); }
await send("Runtime.enable", {}, swSession);
events.length = 0;
await send("Runtime.enable", {}, pageSession);
await sleep(1200);

const ctxs = events.filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === pageSession).map((e) => e.params.context);
const mainCtx = ctxs.find((c) => c.auxData?.isDefault) ?? ctxs[0];

const evalMain = async (expr, awaitPromise = true) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise, contextId: mainCtx.id }, pageSession);
  if (r?.exceptionDetails) return `EXC: ${r.exceptionDetails.exception?.description?.slice(0, 150) ?? r.exceptionDetails.text}`;
  return r?.result?.value;
};
const swEval = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }, swSession);
  return r?.result?.value;
};

// 探测表达式：向一个真实 /live-bvc/ 地址发 fetch，看是否被拦截；
// 同时用一个非直播地址做对照，确保探测本身有效。
const probeExpr = (liveUrl, controlUrl) => `(async()=>{
  const out = {};
  try { const r = await fetch(${JSON.stringify(liveUrl)}, {cache:'no-store'}); out.live = 'OK status=' + r.status; }
  catch (e) { out.live = 'FAILED ' + e.name + ': ' + String(e.message).slice(0,80); }
  try { const r = await fetch(${JSON.stringify(controlUrl)}, {cache:'no-store'}); out.control = 'OK status=' + r.status; }
  catch (e) { out.control = 'FAILED ' + e.name + ': ' + String(e.message).slice(0,80); }
  return JSON.stringify(out);
})()`;

// 取一个真实的 live-bvc 地址：从页面自身最近发过的请求里拿不到，
// 就直接用当前直播间的 playurl 里给的真实 URL（通过页面 fetch playurl 得到）。
const swFetchLiveUrl = `try {
  const r = await fetch('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${ROOM}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8', {cache:'no-store'});
  const j = await r.json();
  const pl = j && j.data && j.data.playurl_info && j.data.playurl_info.playurl;
  if (!pl || !pl.stream) return JSON.stringify({src:'sw', err:'no playurl', code: j && j.code, keys: j && j.data ? Object.keys(j.data).length : -1});
  const urls = [];
  for (const s of pl.stream) for (const f of (s.format||[])) for (const c of (f.codec||[])) {
    const u = (c.url_info||[])[0];
    if (u && c.base_url) urls.push({d: s.protocol_name+'/'+f.format_name+'/'+c.codec_name, url: u.host + c.base_url + u.extra});
  }
  return JSON.stringify({src:'sw', count: urls.length, first: urls[0] ? urls[0].url : null,
    firstDesc: urls[0] ? urls[0].d : null, all: urls.map(x=>x.d)});
} catch (e) { return JSON.stringify({src:'sw', err: String(e.message).slice(0,100)}); }`;

// ------------------------------------------------ 阶段 0：确认视频在播放
log("等视频开始播放...");
let playing = false;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  const v = await evalMain("JSON.stringify([...document.querySelectorAll('video')].map(v=>({b:String(v.currentSrc||'').startsWith('blob:'),rs:v.readyState,p:v.paused,t:v.currentTime})))");
  if (v && v.includes('"p":false') && v.includes('"rs":4')) { log("已确认播放:", v); playing = true; break; }
}
if (!playing) { log("视频未播放，测试无法继续"); child.kill(); process.exit(1); }

// 取一个真实直播流 URL。
// 说明：DNR 只看 URL 模式，不看签名是否仍然有效，所以用抓取记录里的真实
// live-bvc 地址即可验证拦截决策；同时用一个对照地址确保探测本身有效。
import { readFileSync, readdirSync } from "node:fs";

function loadRealLiveUrl() {
  const files = readdirSync("tools").filter((f) => /^capture-.*\.json$/.test(f));
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join("tools", f), "utf8"));
      const hit = (data.mediaRequests ?? []).find((r) => /live-bvc/.test(r.url));
      if (hit) return { url: hit.url, from: f };
    } catch {}
  }
  return null;
}
const realLive = loadRealLiveUrl();
if (!realLive) { log("抓取记录里没有可用的 live-bvc 地址"); child.kill(); process.exit(1); }
const liveUrl = realLive.url;
log(`使用抓取记录中的真实直播流地址（来自 ${realLive.from}）:`);
log(`  ${String(liveUrl).slice(0, 130)}`);
const controlUrl = "https://api.live.bilibili.com/room/v1/Room/get_info?room_id=" + ROOM;

// ------------------------------------------------ 阶段 1：屏蔽前探测
const rulesBefore = await swEval("return JSON.stringify((await chrome.declarativeNetRequest.getDynamicRules()).length);");
log(`\n[屏蔽前] 动态规则数=${rulesBefore}`);
const before = JSON.parse((await evalMain(probeExpr(liveUrl, controlUrl))) ?? "{}");
log(`[屏蔽前] live-bvc fetch : ${before.live}`);
log(`[屏蔽前] 对照 fetch     : ${before.control}`);

// ------------------------------------------------ 阶段 2：开启屏蔽
log("\n>>> 开启屏蔽（写 storage，与 popup 同路径）");
await swEval("await chrome.storage.local.set({enabled:true}); return 1;");
await sleep(500);
const rulesAfter = await swEval("return JSON.stringify((await chrome.declarativeNetRequest.getDynamicRules()).length);");
log(`[屏蔽后] 动态规则数=${rulesAfter}`);

// ------------------------------------------------ 阶段 3：屏蔽后探测
const after = JSON.parse((await evalMain(probeExpr(liveUrl, controlUrl))) ?? "{}");
log(`[屏蔽后] live-bvc fetch : ${after.live}`);
log(`[屏蔽后] 对照 fetch     : ${after.control}`);

// ------------------------------------------------ 阶段 4：视频是否停止
log(`\n观察 ${WATCH_S} 秒，确认视频保持停止、缓冲不再增长...`);
const sb0 = await evalMain("(window.__VLB_PROBE__?.sourceBuffers??[]).reduce((s,b)=>s+(b.appendedBytes||0),0)");
await sleep(WATCH_S * 1000);
const sb1 = await evalMain("(window.__VLB_PROBE__?.sourceBuffers??[]).reduce((s,b)=>s+(b.appendedBytes||0),0)");
const videoEnd = await evalMain("JSON.stringify([...document.querySelectorAll('video')].map(v=>({blob:String(v.currentSrc||v.src||'').startsWith('blob:'),paused:v.paused,rs:v.readyState,w:v.videoWidth,t:v.currentTime})))");

const liveBlockedBefore = /FAILED/.test(before.live ?? "");
const liveBlockedAfter = /FAILED/.test(after.live ?? "");
const controlOk = /OK/.test(after.control ?? "");

log("\n================ 结论 ================");
log(`1) 屏蔽前 live-bvc fetch 成功（说明地址有效）: ${!liveBlockedBefore}`);
log(`2) 屏蔽后 live-bvc fetch 被拦            : ${liveBlockedAfter}  (${after.live})`);
log(`3) 屏蔽后对照地址仍可访问（探测有效）    : ${controlOk}  (${after.control})`);
log(`4) SourceBuffer 增长                     : ${(sb1 ?? 0) - (sb0 ?? 0)} 字节`);
log(`5) 最终视频状态                          : ${videoEnd}`);
log("");
const pass = !liveBlockedBefore && liveBlockedAfter && controlOk && (sb1 - sb0) === 0;
log(pass ? "总体：通过 —— 播放中开启屏蔽后，视频停止且后续直播流请求被真实拦截" : "总体：未通过");

writeFileSync("tools/verify-network.json", JSON.stringify({
  room: ROOM, liveUrl: String(liveUrl).slice(0, 300), controlUrl,
  rulesBefore, rulesAfter,
  before, after,
  sourceBufferBefore: sb0, sourceBufferAfter: sb1, videoEnd, pass,
}, null, 2), "utf8");

try { ws.close(); } catch {}
child.kill();
await sleep(800);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
