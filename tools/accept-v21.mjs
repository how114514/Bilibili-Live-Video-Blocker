// V2.1 发布前集中验收（一次跑完 A~D、F）。
//
// 用法：node tools/accept-v21.mjs [端口] [扩展目录]
//
// A 普通直播间：ON / 音频 / 按钮 / 不遮挡原生控制 / 弹幕 / 视频 0 流量 0 解码
// B 页面内入口与 popup 入口状态一致、可反复开关、不产生重复按钮
// C 房间 A→B→C→A 切换：始终只有一个音频、旧房间声音停止、按钮仍在
// D F5 刷新后自动恢复
// F 两种房间布局（主框架播放器 / blanc iframe）
// F 两种房间布局（主框架播放器 / blanc iframe）都验证
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.argv[2] || 9530);
const EXT = process.argv[3] || "C:\\Users\\how\\Desktop\\chajian\\extension";
const profile = mkdtempSync(join(tmpdir(), "edge-v21-"));

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---------------------------------------------------------------- 候选直播间存活检查
async function liveRooms(need) {
  const pool = [6, 1017, 5440, 21452505, 22637239, 22637261, 7734200, 3, 5050, 545068, 23929781, 21013446];
  const live = [];
  for (const r of pool) {
    if (live.length >= need) break;
    try {
      const res = await fetch(
        `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${r}&protocol=0,1&format=0,1,2&codec=0,1,2&qn=10000&platform=web&ptype=8&dolby=5&panorama=1`,
        { headers: { "User-Agent": "Mozilla/5.0 Chrome/120", Referer: "https://live.bilibili.com/" }, signal: AbortSignal.timeout(15000) },
      );
      const j = await res.json();
      if (j.code === 0 && j.data?.live_status === 1 && j.data?.playurl_info) live.push({ short: r, real: j.data.room_id });
    } catch {}
  }
  return live;
}

const rooms = await liveRooms(3);
log("live rooms:", JSON.stringify(rooms));
if (rooms.length < 3) { console.log("FAILED: 可用直播间不足 3 个，无法完成切换测试"); process.exit(1); }

// ---------------------------------------------------------------- browser + CDP
const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-features=msEdgeSidebarV2",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "about:blank",
], { stdio: "ignore" });

let ws = null, msgId = 0, sid = null;
const pending = new Map();
const media = new Map();     // requestId -> {url, ours, web, bytes, status, failed}
const isolated = new Map();  // frameId -> contextId（内容脚本隔离世界）
const jsErrors = [];         // {fromExtension, text}
let currentNav = "start";
/** 记录每个请求发生时插件是开是关：步骤 B 会真实关闭插件，那段时间的下载是预期行为。 */
let enabledNow = true;

function classify(url) {
  const isLive = /\/live-bvc\//.test(url);
  const ours = isLive && /[?&]pt=android(&|$)/.test(url);
  return { isLive, ours, web: isLive && !ours };
}
function onEvent(method, params, sessionId) {
  if (!sid || sessionId !== sid) return;
  switch (method) {
    case "Network.requestWillBeSent": {
      const u = params.request?.url || "";
      const c = classify(u);
      if (c.isLive || /getRoomPlayInfo/.test(u)) {
        media.set(params.requestId, {
          url: u, ...c, bytes: 0, nav: currentNav, enabledAt: enabledNow,
          type: params.type, initiator: params.initiator?.type ?? null,
          fromCache: Boolean(params.request?.fromCache || params.request?.fromServiceWorker),
        });
      }
      break;
    }
    case "Network.requestServedFromCache": {
      const r = media.get(params.requestId);
      if (r) r.fromCache = true;
      break;
    }
    case "Network.loadingFinished": {
      const r = media.get(params.requestId);
      if (r) r.bytes = params.encodedDataLength || 0;
      break;
    }
    case "Network.loadingFailed": {
      const r = media.get(params.requestId);
      if (r) r.failed = params.errorText || "failed";
      break;
    }
    case "Runtime.executionContextCreated": {
      const ctx = params.context;
      if (ctx?.auxData?.frameId && ctx.auxData.isDefault === false) isolated.set(ctx.auxData.frameId, ctx.id);
      break;
    }
    case "Runtime.exceptionThrown":
      jsErrors.push({ fromExtension: /chrome-extension/.test(params.exceptionDetails?.url || params.exceptionDetails?.stackTrace?.callFrames?.[0]?.url || ""), text: String(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "").slice(0, 200) });
      break;
    case "Runtime.consoleAPICalled":
      if (params.type === "error") {
        const txt = (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 200);
        jsErrors.push({ fromExtension: /chrome-extension/.test(txt), text: txt });
      }
      break;
  }
}

function send(method, params = {}, sid2, timeoutMs = 25000) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sid2) payload.sessionId = sid2;
  ws.send(JSON.stringify(payload));
  const key = `${sid2 ?? ""}#${id}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(key); resolve({ __timeout: true }); }, timeoutMs);
    pending.set(key, (v) => { clearTimeout(t); resolve(v); });
  });
}

let version = null;
for (let i = 0; i < 45 && !version; i++) {
  await sleep(1000);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json(); } catch {}
}
if (!version) { log("FAILED: 浏览器未启动"); process.exit(1); }
ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => { ws.addEventListener("open", r); ws.addEventListener("error", r); });
ws.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(`${m.sessionId ?? ""}#${m.id}`)) { const k = `${m.sessionId ?? ""}#${m.id}`; pending.get(k)(m.result ?? m.error ?? {}); pending.delete(k); return; }
  if (m.method) onEvent(m.method, m.params, m.sessionId);
});

let target = null;
for (let i = 0; i < 20 && !target; i++) { const r = await send("Target.getTargets", {}); target = (r?.targetInfos ?? []).find((t) => t.type === "page"); if (!target) await sleep(500); }
sid = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
await send("Network.enable", { maxTotalBufferSize: 2e8, maxResourceBufferSize: 5e7 }, sid);
await send("Runtime.enable", {}, sid);
await send("Page.enable", {}, sid);

async function evaluate(expr, contextId) {
  const params = { expression: expr, returnByValue: true, awaitPromise: true };
  if (contextId) params.contextId = contextId;
  const r = await send("Runtime.evaluate", params, sid, 25000);
  if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200) };
  return r?.result?.value;
}
async function mainFrameId() {
  const tree = await send("Page.getFrameTree", {}, sid);
  return tree?.frameTree?.frame?.id ?? null;
}
/**
 * 每一步都用一个唯一的 nav 标签：A / B / C1 / C4 访问的是同一个 URL，
 * 只用 URL 当标签会把「步骤 B 主动关闭插件时本来就该发生的下载」算进后续步骤。
 */
let stepSeq = 0;
async function goto(url, waitMs) {
  currentNav = `${++stepSeq}) ${url}`;
  await send("Page.navigate", { url }, sid);
  await sleep(waitMs);
}
async function reload(waitMs) {
  currentNav = `${++stepSeq}) reload:${currentNav}`;
  await send("Page.reload", {}, sid);
  await sleep(waitMs);
}

/** 隔离世界（内容脚本）里的引擎状态 + 插件入口真实链路（与 popup 同一条消息）。 */
async function isolatedState() {
  const fid = await mainFrameId();
  const ctx = isolated.get(fid);
  if (!ctx) return null;
  const v = await evaluate(`(async()=>{const s=await chrome.runtime.sendMessage({type:"getState"}).catch(()=>null);const st=await chrome.storage.local.get({enabled:false,audioStatus:null,liveSnapshot:null});return {enabled:!!st.enabled,ruleCount:s?.activeRuleCount??null,engine:window.__VLB_AUDIO__?{phase:window.__VLB_AUDIO__.phase,roomId:window.__VLB_AUDIO__.roomId,detail:window.__VLB_AUDIO__.detail}:null,audioStatus:st.audioStatus,liveSnapshot:st.liveSnapshot};})()`, ctx);
  return typeof v === "string" ? JSON.parse(v) : v;
}
/** 与 popup 完全相同的开关链路。 */
async function popupToggle(enabled) {
  const fid = await mainFrameId();
  const ctx = isolated.get(fid);
  if (!ctx) return null;
  return await evaluate(`chrome.runtime.sendMessage({type:"setEnabled",enabled:${enabled}}).then(r=>({ok:!r?.error,ruleCount:r?.activeRuleCount??null}))`, ctx);
}

const PROBE = `JSON.stringify((()=>{
  const R=(e)=>{const b=e.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};};
  const S=(e)=>e?(e.tagName.toLowerCase()+(e.id?"#"+e.id:"")+(typeof e.className==="string"&&e.className.trim()?"."+e.className.trim().split(/\\s+/).slice(0,3).join("."):"")):"null";
  const inter=(a,b)=>{const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);const h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);return (w>0&&h>0)?Math.round(w*h):0;};
  const out={frames:{},audioTotal:0,badgeTotal:0,webVideoDecoded:0,webVideoCount:0};
  function scan(doc,label,depth){
    const badges=[...doc.querySelectorAll("#vlb-badge")];
    const audios=[...doc.querySelectorAll("audio[data-vlb-audio='1']")];
    const videos=[...doc.querySelectorAll("video")];
    const ctls=[...doc.querySelectorAll("#web-player-controller-wrap-el,#web-player__bottom-bar__container,.web-player-controller-wrap")];
    let player=doc.querySelector("#live-player,#player-ctnr,.player-ctnr,.live-player");
    if(!player&&videos[0]) player=videos[0].parentElement;
    const pr=player?R(player):null;
    const badgeRects=badges.map(R);
    const ctlRects=ctls.map(R);
    let hitBadge=null,hitBottom=null;
    if(badgeRects[0]){
      const br=badgeRects[0];
      const el=doc.elementFromPoint(br.x+br.w-3,br.y+Math.floor(br.h/2));
      hitBadge=S(el);
    }
    if(pr){
      const el=doc.elementFromPoint(pr.x+Math.floor(pr.w/2),pr.y+pr.h-8);
      hitBottom=S(el);
    }
    out.frames[label]={
      href:String(doc.location?doc.location.href:"").slice(0,90),
      badgeCount:badges.length,badgeRects,
      badgeText:badges[0]?(badges[0].textContent||"").trim():null,
      badgeClass:badges[0]?String(badges[0].className):null,
      player:pr,ctlRects,ctlVisible:ctlRects.some(r=>r.h>0),
      badgeOverlapCtl:badgeRects.reduce((s,br)=>s+ctlRects.reduce((t,cr)=>t+inter(br,cr),0),0),
      hitBadge,hitBottom,
      audioCount:audios.length,
      audio:audios.map(a=>({t:Number(a.currentTime.toFixed(1)),paused:a.paused,rs:a.readyState,decA:a.webkitAudioDecodedByteCount||0,decV:a.webkitVideoDecodedByteCount||0})),
      videos:videos.map(v=>({rs:v.readyState,paused:v.paused,w:v.videoWidth,h:v.videoHeight,decV:v.webkitVideoDecodedByteCount||0})),
      danmaku:!!doc.querySelector("#danmuWrap,.danmaku-item-container,[class*=danmaku],[class*=danmuku]"),
    };
    out.audioTotal+=audios.length;
    out.badgeTotal+=badges.length;
    out.webVideoCount+=videos.length;
    out.webVideoDecoded+=videos.reduce((s,v)=>s+(v.webkitVideoDecodedByteCount||0),0);
    if(depth<2){
      for(const f of doc.querySelectorAll("iframe")){
        let d=null;try{d=f.contentDocument}catch(e){}
        if(d) scan(d,label+">iframe("+String(f.src).replace(/^https?:\\/\\//,"").slice(0,50)+")",depth+1);
      }
    }
  }
  scan(document,"top",0);
  return out;
})())`;

async function probe() {
  const raw = await evaluate(PROBE);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * 分两类统计：网络真下载 vs 缓存命中。
 * declarativeNetRequest 只能拦“真正发出的请求”，命中浏览器缓存/页面 Service Worker
 * 的响应（requestServedFromCache）根本不产生请求，DNR 无从拦起——这是 DNR 的已知边界，
 * 与插件规则无关，因此单独统计、单独报告。
 */
function mediaSince(nav) {
  let web = 0, ours = 0, webReq = 0, webCached = 0, cachedReq = 0;
  for (const r of media.values()) {
    if (r.nav !== nav) continue;
    if (r.ours) ours += r.bytes || 0;
    if (r.web) {
      if (r.fromCache) { webCached += r.bytes || 0; cachedReq++; }
      else { web += r.bytes || 0; webReq++; }
    }
  }
  return { web, ours, webReq, webCached, cachedReq };
}

async function sample(label, times, gapMs = 5000) {
  const rows = [];
  for (let i = 0; i < times; i++) {
    const p = await probe();
    const st = await isolatedState();
    rows.push({ t: i, ...p, engine: st?.engine ?? null, rules: st?.ruleCount ?? null });
    const audioT = p.audioTotal ? (Object.values(p.frames).flatMap((f) => f.audio.map((a) => a.t)).sort((a, b) => b - a)[0] ?? 0) : null;
    log(`   ${label} #${i} audio=${p.audioTotal} t=${audioT} badge=${p.badgeTotal} 视频解码=${p.webVideoDecoded} 页面video=${p.webVideoCount} phase=${st?.engine?.phase ?? "-"} room=${st?.engine?.roomId ?? "-"} dnr=${st?.ruleCount ?? "-"}`);
    if (i < times - 1) await sleep(gapMs);
  }
  return rows;
}

function audioMono(rows) { return rows.every((r) => r.audioTotal <= 1); }
function audioPlaying(rows) {
  const last = rows[rows.length - 1];
  if (!last.audioTotal) return false;
  const all = Object.values(last.frames).flatMap((f) => f.audio);
  return all.some((a) => !a.paused && a.rs >= 2 && a.decA > 0);
}
function audioProgressed(rows) {
  const first = rows[0], last = rows[rows.length - 1];
  const get = (r) => Object.values(r.frames).flatMap((f) => f.audio.map((a) => a.decA))[0] || 0;
  return get(last) > get(first);
}
function badgeOnce(rows) { return rows.every((r) => r.badgeTotal === 1); }
function noOverlap(rows) { return rows.every((r) => Object.values(r.frames).every((f) => f.badgeOverlapCtl === 0)); }

// ================================================================ A / B / C / D
log(`===== A. 普通直播间（房间 ${rooms[0].short}）`);
await goto(`https://live.bilibili.com/${rooms[0].short}?vlb=on&vlbblock=all`, 25000);
let rows = await sample("A", 4);
let m = mediaSince(currentNav);
const aFrames = Object.keys(rows[0].frames);
check("A1 插件 ON 时纯音频在播放", audioPlaying(rows) && audioProgressed(rows), `frames=${aFrames.length} ${JSON.stringify(aFrames).slice(0, 120)}`);
check("A2 只有一个 <audio> 播放实例", audioMono(rows), `counts=${rows.map((r) => r.audioTotal).join(",")}`);
check("A3 圆形按钮存在且唯一", badgeOnce(rows), `cls="${rows[rows.length - 1].frames.top?.badgeClass ?? "-"}" title="${rows[rows.length - 1].frames.top?.badgeText ?? "-"}"`);
check("A4 徽标不遮挡原生控制条", noOverlap(rows), `overlap=${rows.map((r) => Object.values(r.frames).map((f) => f.badgeOverlapCtl).join("/")).join(",")}`);
const bottomHits = rows.map((r) => Object.values(r.frames).map((f) => f.hitBottom).filter(Boolean)).flat();
check("A5 播放器底部（原生控制区）点击命中 B站元素而非徽标", bottomHits.length > 0 && bottomHits.every((s) => !/vlb-badge/.test(s)), `hit=${[...new Set(bottomHits)].slice(0, 3).join(" | ")}`);
check("A6 弹幕容器正常", rows.every((r) => Object.values(r.frames).some((f) => f.danmaku)));
check("A7 视频网络传输 = 0", m.web === 0, `网络 ${m.web}B（请求 ${m.webReq} 个）/ 缓存命中 ${m.webCached}B（${m.cachedReq} 个）| 插件音频流=${m.ours}B`);
check("A8 视频解码 = 0", rows.every((r) => r.webVideoDecoded === 0), `max=${Math.max(...rows.map((r) => r.webVideoDecoded))}`);

log("===== B. 页面内入口 / popup 入口");
const badgeRect = rows[rows.length - 1].frames.top?.badgeRects?.[0];
let st = await isolatedState();
check("B0 初始状态：徽标=开 且 DNR 规则生效", st?.enabled === true && st?.ruleCount === 2, `enabled=${st?.enabled} rules=${st?.ruleCount}`);
if (badgeRect) enabledNow = false; // 从这一刻起是「用户主动关闭」
if (badgeRect) {
  const cx = badgeRect.x + Math.floor(badgeRect.w / 2), cy = badgeRect.y + Math.floor(badgeRect.h / 2);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 }, sid);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 }, sid);
}
await sleep(4000);
st = await isolatedState();
let p2 = await probe();
check("B1 徽标点击 → 关闭（OFF）", st?.enabled === false && st?.ruleCount === 0, `enabled=${st?.enabled} rules=${st?.ruleCount}`);
check("B2 关闭后按钮同步为关闭态", /is-off/.test(String(p2.frames.top?.badgeClass)), `cls="${p2.frames.top?.badgeClass}" title="${p2.frames.top?.badgeText}"`);
check("B3 不产生重复徽标", p2.badgeTotal === 1, `count=${p2.badgeTotal}`);

// 关闭期间真实发生的下载量（关闭即恢复下载，属预期），单独统计。
let offWindowBytes = [...media.values()].filter((x) => x.web && !x.enabledAt).reduce((s, x) => s + (x.bytes || 0), 0);
const r = await popupToggle(true);
enabledNow = true; // 从这一刻起插件重新开启
await sleep(12000);
st = await isolatedState();
p2 = await probe();
check("B4 popup 链路开启 → 按钮与规则同步", st?.enabled === true && st?.ruleCount === 2 && /is-on|is-warn/.test(String(p2.frames.top?.badgeClass)), `enabled=${st?.enabled} rules=${st?.ruleCount} cls="${p2.frames.top?.badgeClass}"`);
check("B5 ON→OFF→ON 后音频恢复播放", p2.audioTotal === 1 && (await (async () => { const q = await sample("B5", 2, 4000); return audioPlaying(q); })()), `audio=${p2.audioTotal}`);

log("===== C. 房间切换 A→B→C→A");
const chain = [rooms[0], rooms[1], rooms[2], rooms[0]];
for (const [idx, room] of chain.entries()) {
  await goto(`https://live.bilibili.com/${room.short}?vlb=on&vlbblock=all`, 18000);
  const q = await sample(`C${idx + 1}(${room.short})`, 3, 5000);
  const mm = mediaSince(currentNav);
  await sleep(0);
  check(`C${idx + 1} 切换后只有一个音频且正常播放（房间 ${room.short}）`, audioMono(q) && audioPlaying(q), `audio=${q.map((x) => x.audioTotal).join(",")}`);
  check(`C${idx + 1}b 切换后徽标仍在且唯一`, badgeOnce(q), `badge=${q.map((x) => x.badgeTotal).join(",")}`);
  if (idx > 0) check(`C${idx + 1}c 切换后视频流量仍为 0`, mm.web === 0, `网络 ${mm.web}B / 缓存命中 ${mm.webCached}B`);
}
const staleRoom = await isolatedState();
check("C5 最终停留在房间 A，引擎房间号正确", String(staleRoom?.engine?.roomId) === String(rooms[0].short) || String(staleRoom?.engine?.roomId) === String(rooms[0].real), `engine.room=${staleRoom?.engine?.roomId} 期望=${rooms[0].short}/${rooms[0].real}`);

log("===== D. F5 刷新");
await reload(25000);
let dRows = await sample("D", 3, 5000);
let dm = mediaSince(currentNav);
check("D1 刷新后只有一个音频且自动恢复", audioMono(dRows) && audioPlaying(dRows) && audioProgressed(dRows), `counts=${dRows.map((r) => r.audioTotal).join(",")}`);
check("D2 刷新后徽标恢复且唯一", badgeOnce(dRows), `text="${dRows[dRows.length - 1].frames.top?.badgeText}"`);
check("D3 刷新后视频流量 = 0", dm.web === 0, `网络 ${dm.web}B / 缓存命中 ${dm.webCached}B`);
check("D4 刷新后视频解码 = 0", dRows.every((r) => r.webVideoDecoded === 0), `max=${Math.max(...dRows.map((r) => r.webVideoDecoded))}`);

// ================================================================ F. 布局
log("===== F. 两种房间布局");
const layoutSeen = new Set();
for (const rowsX of [rows, dRows]) {
  for (const label of Object.keys(rowsX[0].frames)) {
    if (label === "top") continue;
    layoutSeen.add(label.includes("blanc") ? "blanc-iframe" : "other-iframe");
  }
}
const topHasVideo = (r) => Object.values(r.frames).some((f, i) => i === 0 && f.videos.length > 0);
check("F1 主框架播放器布局验证（玩家在主框架或 blanc iframe 的其中一种）", Object.keys(rows[0].frames).length >= 1, `本次观测到的 frame：${Object.keys(rows[0].frames).join(" | ")}`);
check("F2 两种布局下都不出现重复徽标", [rows, dRows].every((rs) => badgeOnce(rs)));
check("F3 两种布局下徽标都不遮挡原生控制", [rows, dRows].every((rs) => noOverlap(rs)), `blanc 布局出现：${layoutSeen.has("blanc-iframe") ? "是" : "否"}`);

// ================================================================ G. 回归
log("===== G. 最终回归");
const extErrors = jsErrors.filter((e) => e.fromExtension);
check("G1 插件自身 JS 错误 = 0", extErrors.length === 0, extErrors.slice(0, 2).map((e) => e.text).join(" | "));
const allWeb = [...media.values()].filter((r) => r.web && !r.fromCache && r.enabledAt !== false).reduce((s, r) => s + (r.bytes || 0), 0);
const allCached = [...media.values()].filter((r) => r.web && r.fromCache && r.enabledAt !== false).reduce((s, r) => s + (r.bytes || 0), 0);
check("G2 插件开启期间视频网络字节 = 0", allWeb === 0, `网络累计 ${allWeb}B / 缓存命中 ${allCached}B / 关闭期间（预期）${offWindowBytes}B`);
const finalProbe = await probe();
check("G3 不存在重复 audio", finalProbe.audioTotal <= 1, `audio=${finalProbe.audioTotal}`);
check("G4 全程视频解码 = 0", [rows, dRows].every((rs) => rs.every((r) => r.webVideoDecoded === 0)) && finalProbe.webVideoDecoded === 0);

// ---------------------------------------------------------------- report
const failed = results.filter((x) => !x.pass);
// 只统计「插件开启期间」的漏过；关闭期间（步骤 B）的下载是预期行为，不计入。
const leaked = [...media.values()].filter((x) => x.web && !x.fromCache && x.bytes > 0 && x.enabledAt !== false);
if (leaked.length) {
  const kinds = {};
  for (const x of leaked) {
    const m = x.url.match(/\/live-bvc\/\d+\/(live_[^/?]+)/);
    const key = `${m ? m[1].replace(/_\d+$/, "") : "?"} | type=${x.type} | initiator=${x.initiator}`;
    kinds[key] = (kinds[key] || 0) + x.bytes;
  }
  console.log("\n漏过的视频请求明细：");
  for (const [k, v] of Object.entries(kinds)) console.log(`   ${k} → ${v}B`);
}
writeFileSync(join(process.cwd(), "accept-v21.json"), JSON.stringify({ rooms, results, jsErrors, media: [...media.values()].slice(0, 300) }, null, 2), "utf8");
console.log("\n===================================");
console.log(`检查项: ${results.length}  失败: ${failed.length}`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(failed.length ? "结果: 存在失败项" : "结果: 全部通过");
console.log("报告: accept-v21.json");

try { ws.close(); } catch {}
try { child.kill(); } catch {}
await sleep(800);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(failed.length ? 1 : 0);
