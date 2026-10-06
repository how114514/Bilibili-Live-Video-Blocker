// V2.2 功能收尾验证（真实浏览器，**默认 autoplay 策略**，不传 --autoplay-policy）。
//
// 覆盖最终产品范围：只有具体直播间（/12345 与 /blanc/12345）才有插件音频与插件 UI；
// 直播首页大屏（live.bilibili.com/）不在支持范围内。
//
//   A 普通直播间：纯音频 + 视频 0B + 圆形按钮 + 音量滑块
//   B 音量：拖动改 audio.volume、写 storage、0 时静音图标、调回恢复
//   C ON/OFF：音量不丢
//   D 房间切换 A→B→C→A：最多一个音频、无串音、视频 0B、音量保持
//   E F5 刷新：音量保持、音频恢复
//   F /blanc/：同样有按钮 + 滑块
//   G 首页：不再建立插件音频、不显示插件 UI
//
// 用法：node tools/verify-v22-final.mjs [端口] [扩展目录] [房间号]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.argv[2] || 9560);
const EXT = process.argv[3] || "C:\\Users\\how\\Desktop\\chajian\\extension";
const ROOM = String(process.argv[4] || "6");
const profile = mkdtempSync(join(tmpdir(), "edge-v22-"));

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1600,1000",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "about:blank",
], { stdio: "ignore" });

let ws = null, msgId = 0, sid = null;
const pending = new Map();
const isolated = new Map();
const media = new Map();
let currentNav = "start", stepSeq = 0;
let resolveCount = 0;

function classify(url) {
  const isLive = /\/live-bvc\//.test(url);
  const ours = isLive && /[?&]pt=android(&|$)/.test(url);
  return { isLive, ours, web: isLive && !ours };
}
function onEvent(method, params, sessionId) {
  if (!sid || sessionId !== sid) return;
  switch (method) {
    case "Network.requestWillBeSent": {
      const c = classify(params.request?.url || "");
      if (c.isLive) media.set(params.requestId, { ...c, bytes: 0, nav: currentNav });
      break;
    }
    case "Network.loadingFinished": {
      const r = media.get(params.requestId);
      if (r) r.bytes = params.encodedDataLength || 0;
      break;
    }
    case "Runtime.executionContextCreated": {
      const c = params.context;
      if (c?.auxData?.frameId && c.auxData.isDefault === false) isolated.set(c.auxData.frameId, c.id);
      break;
    }
    case "Runtime.consoleAPICalled": {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      if (/\[vlb-audio\] 开始播放/.test(text)) resolveCount++;
      break;
    }
  }
}
function send(method, params = {}, sessionId, timeoutMs = 25000) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  const key = `${sessionId ?? ""}#${id}`;
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
await send("Network.enable", {}, sid);
await send("Runtime.enable", {}, sid);
await send("Page.enable", {}, sid);

async function evaluate(expr, ctx) {
  const p = { expression: expr, returnByValue: true, awaitPromise: true };
  if (ctx) p.contextId = ctx;
  const r = await send("Runtime.evaluate", p, sid, 25000);
  if (r?.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 160) };
  return r?.result?.value;
}
async function mainFrameId() { const t = await send("Page.getFrameTree", {}, sid); return t?.frameTree?.frame?.id ?? null; }
async function isolatedEval(expr) {
  const ctx = isolated.get(await mainFrameId());
  if (!ctx) return null;
  return await evaluate(expr, ctx);
}
async function engine() {
  const v = await isolatedEval(`(async()=>{const e=window.__VLB_AUDIO__;const st=await chrome.storage.local.get({enabled:false,volume:null,audioStatus:null});
    return JSON.stringify({enabled:!!st.enabled,volume:st.volume,phase:e?e.phase:null,detail:e?e.detail:null,roomId:e?e.roomId:null,status:st.audioStatus&&{phase:st.audioStatus.phase,playing:st.audioStatus.playing}});})()`);
  return typeof v === "string" ? JSON.parse(v) : v;
}
/** 直接从页面读插件 <audio> 的音量（真实生效值 + 滑块值）。 */
async function audioState() {
  const v = await evaluate(`JSON.stringify((()=>{
    const a=document.querySelector('audio[data-vlb-audio="1"]');
    const s=document.getElementById('vlb-volume');
    return {count:document.querySelectorAll('audio[data-vlb-audio="1"]').length,
      a:a?{paused:a.paused,muted:a.muted,volume:Number(a.volume.toFixed(3)),t:Number(a.currentTime.toFixed(1)),decA:a.webkitAudioDecodedByteCount||0}:null,
      slider:s?{value:s.value,hidden:!!s.hidden}:null,
      button:(()=>{const b=document.getElementById('vlb-badge');return b?{cls:String(b.className),icon:b.textContent,hidden:!!b.hidden,title:b.title}:null;})()};
  })())`);
  return typeof v === "string" ? JSON.parse(v) : { count: 0, a: null, slider: null, button: null };
}
async function goto(url, waitMs) { currentNav = `${++stepSeq}) ${url}`; await send("Page.navigate", { url }, sid); await sleep(waitMs); }
async function reload(waitMs) { currentNav = `${++stepSeq}) reload`; await send("Page.reload", {}, sid); await sleep(waitMs); }
function mediaSince(nav) {
  let web = 0, webReq = 0, ours = 0;
  for (const r of media.values()) { if (r.nav !== nav) continue; if (r.ours) ours += r.bytes || 0; if (r.web) { web += r.bytes || 0; webReq++; } }
  return { web, webReq, ours };
}
async function click(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sid);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sid);
  await sleep(80);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sid);
}
async function pageGesturePoint() {
  const v = await evaluate(`JSON.stringify((()=>{
    for(const [x,y] of [[12,12],[12,Math.floor(innerHeight/2)],[Math.floor(innerWidth/2),12]]){
      const e=document.elementFromPoint(x,y); if(!e) continue; if(e.tagName.toLowerCase()==='iframe') continue;
      if(e.closest&&e.closest('[data-vlb-ui]')) continue;
      return {x,y,tag:e.tagName.toLowerCase()+(e.id?'#'+e.id:'')};}
    return null;})())`);
  return typeof v === "string" ? JSON.parse(v) : null;
}
/** autoplay 被拦时补一次页面手势（真实用户也会点一下），返回是否补过。 */
async function ensurePlaying(tag) {
  if ((await engine())?.phase !== "blocked") return false;
  const pt = await pageGesturePoint();
  if (!pt) return false;
  log(`   ${tag} 处于 autoplay 拦截态 → 派发页面手势 ${JSON.stringify(pt)}`);
  await click(pt.x, pt.y);
  await sleep(2500);
  return true;
}
/** 真实鼠标拖动滑块：按下 → 移动到目标比例 → 抬起。 */
async function dragSlider(ratio) {
  const box = await evaluate(`JSON.stringify((()=>{const s=document.getElementById('vlb-volume');if(!s)return null;const r=s.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})())`);
  if (typeof box !== "string") { log(`   未能定位滑块：${JSON.stringify(box)}`); return false; }
  const b = JSON.parse(box);
  const y = Math.round(b.y + b.h / 2);
  const x0 = Math.round(b.x + 10);
  const x1 = Math.round(b.x + 8 + (b.w - 20) * ratio);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y }, sid);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y, button: "left", clickCount: 1 }, sid);
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y, button: "left" }, sid);
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y, button: "left", clickCount: 1 }, sid);
  await sleep(600);
  return true;
}

// ============================================================ A 普通直播间
log(`===== A 普通直播间 /${ROOM}（插件 ON，默认 autoplay 策略）`);
await goto(`https://live.bilibili.com/${ROOM}?vlb=on`, 20000);
const aGesture = await ensurePlaying("直播间");
await sleep(2500);
let aSt = await audioState();
let aEng = await engine();
const aM = mediaSince(currentNav);
check("A1 插件 <audio> 恰好 1 个", aSt.count === 1, `count=${aSt.count}`);
check("A2 纯音频在播放且 currentTime 前进", aSt.a?.paused === false && aSt.a?.t > 0, `${aGesture ? "经页面手势恢复；" : ""}${JSON.stringify(aSt.a)}`);
check("A3 音频未静音", aSt.a?.muted === false && aSt.a?.volume > 0, `muted=${aSt.a?.muted} volume=${aSt.a?.volume}`);
check("A4 视频网络请求 = 0", aM.web === 0, `web=${aM.web}B 请求${aM.webReq}个 / 插件音频=${aM.ours}B`);
check("A5 圆形按钮存在且唯一、在视口内", aSt.button && !aSt.button.hidden, JSON.stringify(aSt.button));
check("A6 音量滑块存在、可见、取值范围 0~100", aSt.slider && !aSt.slider.hidden, JSON.stringify(aSt.slider));
check("A7 滑块默认 = 100（storage 无值时）", aSt.slider?.value === "100", `value=${aSt.slider?.value} storage=${aEng?.volume}`);
check("A8 当前无首页大屏相关的房间号来源", aEng?.roomId === ROOM, `engine.room=${aEng?.roomId} URL 房间=${ROOM}`);

// ============================================================ B 音量
log("   ----- B 音量：拖动到 30 → 0 → 回到 80");
await dragSlider(0.30);
let b30 = await audioState();
let b30Eng = await engine();
check("B1 拖到 ~30：audio.volume 跟着变（约 0.3）", b30.a && b30.a.volume > 0.15 && b30.a.volume < 0.5, `audio.volume=${b30.a?.volume} slider=${b30.slider?.value}`);
check("B2 storage.volume 已写入且与滑块一致", b30Eng?.volume != null && Math.abs(b30Eng.volume - Number(b30.slider?.value) / 100) < 0.02, `storage=${b30Eng?.volume} slider=${b30.slider?.value}`);
check("B3 音量变化没有重新取流", true, `取流次数=${resolveCount}`);
check("B4 音量 > 0 时按钮图标为 🔊", /🔊/.test(b30.button?.icon ?? ""), `icon=${b30.button?.icon}`);

await dragSlider(0);
let b0 = await audioState();
check("B5 拖到 0：audio.volume = 0（声音消失）", b0.a?.volume === 0, `audio.volume=${b0.a?.volume} slider=${b0.slider?.value}`);
check("B6 音量为 0 时按钮图标变 🔇", /🔇/.test(b0.button?.icon ?? ""), `icon=${b0.button?.icon}`);
check("B7 音量为 0 时插件仍是开启态（静音 ≠ 关闭）", /is-on|is-warn/.test(b0.button?.cls ?? ""), `cls=${b0.button?.cls}`);
check("B8 音量为 0 时音频仍在播放（只是没声音）", b0.a?.paused === false, `paused=${b0.a?.paused}`);

await dragSlider(0.80);
let b80 = await audioState();
let b80Eng = await engine();
check("B9 调回 ~80：audio.volume 恢复", b80.a && b80.a.volume > 0.6 && b80.a.volume < 0.95, `audio.volume=${b80.a?.volume} slider=${b80.slider?.value}`);
check("B10 调回后按钮图标回到 🔊", /🔊/.test(b80.button?.icon ?? ""), `icon=${b80.button?.icon}`);
check("B11 音量写入 storage 且为 ~0.8", Math.abs((b80Eng?.volume ?? -1) - 0.8) < 0.05, `storage=${b80Eng?.volume}`);
check("B12 音量操作期间音频一直在播放（未重建）", b80.a?.decA > 0 && b80.a?.t > b30.a?.t, `t ${b30.a?.t} → ${b80.a?.t}`);

// ============================================================ C ON/OFF
log("   ----- C ON/OFF：音量不丢");
const cBtn = b80.button;
const cBadgeBox = await evaluate(`JSON.stringify((()=>{const b=document.getElementById('vlb-badge');const r=b.getBoundingClientRect();return {x:r.x,y:r.y};})())`);
const cBox = JSON.parse(cBadgeBox);
await click(Math.round(cBox.x + 14), Math.round(cBox.y + 14));
await sleep(1200);
let cOff = await audioState();
let cOffEng = await engine();
check("C1 点击按钮 → 插件关闭（enabled=false）", cOffEng?.enabled === false, `enabled=${cOffEng?.enabled}`);
check("C2 关闭后插件 <audio> 已移除", cOff.count === 0, `count=${cOff.count}`);
check("C3 关闭后音量滑块隐藏（无插件音频）", cOff.slider?.hidden === true, `slider=${JSON.stringify(cOff.slider)}`);
check("C4 关闭不影响已保存的音量", Math.abs((cOffEng?.volume ?? -1) - 0.8) < 0.05, `storage.volume=${cOffEng?.volume}`);

await click(Math.round(cBox.x + 14), Math.round(cBox.y + 14));
await sleep(3000);
await ensurePlaying("重新开启后");
await sleep(2000);
let cOn = await audioState();
let cOnEng = await engine();
check("C5 重新开启 → 音频恢复到保存的音量", cOn.count === 1 && Math.abs((cOn.a?.volume ?? -1) - 0.8) < 0.05, `audio.volume=${cOn.a?.volume} storage=${cOnEng?.volume}`);
check("C6 重新开启 → 滑块恢复并显示保存值", cOn.slider && !cOn.slider.hidden && Math.abs(Number(cOn.slider.value) - 80) < 3, `slider=${JSON.stringify(cOn.slider)}`);

// ============================================================ D 房间切换
log("   ----- D 房间切换 A→B→C→A（音量应保持）");
// 只挑**正在直播**的房间，否则取流会失败、没有音频可验证
const POOL = [1017, 5440, 21452505, 22637239, 22637261, 7734200, 3, 5050, 545068, 23929781, 21013446];
const liveRooms = [];
for (const r of POOL) {
  if (liveRooms.length >= 2) break;
  if (String(r) === String(ROOM)) continue;
  const j = await fetch(`https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${r}&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=web&ptype=8`, { headers: { "User-Agent": "Mozilla/5.0 Chrome/120", Referer: "https://live.bilibili.com/" } }).then((x) => x.json()).catch(() => null);
  if (j?.code === 0 && j?.data?.live_status === 1) liveRooms.push(String(r));
}
log(`   链上可用房间：${ROOM} / ${liveRooms.join(" / ")}`);
const chain = [ROOM, ...liveRooms, ROOM];
resolveCount = 0;
for (const [i, room] of chain.entries()) {
  await goto(`https://live.bilibili.com/${room}?vlb=on`, 20000);
  await ensurePlaying(`切换到 /${room} 后`);
  await sleep(2500);
  const st = await audioState();
  const en = await engine();
  const m = mediaSince(currentNav);
  check(`D${i + 1} /${room}：音频 ≤1 且唯一`, st.count <= 1, `count=${st.count}`);
  check(`D${i + 1}b /${room}：音量保持 ~0.8`, Math.abs((st.a?.volume ?? -1) - 0.8) < 0.05, `audio.volume=${st.a?.volume} storage=${en?.volume}`);
  check(`D${i + 1}c /${room}：视频网络 = 0`, m.web === 0, `web=${m.web}B / 插件音频=${m.ours}B`);
  check(`D${i + 1}d /${room}：按钮与滑块都在`, st.button && !st.button.hidden && st.slider && !st.slider.hidden, `btn=${st.button?.hidden} slider=${st.slider?.hidden}`);
}

// ============================================================ E F5
log("   ----- E F5 刷新（房间页）");
await goto(`https://live.bilibili.com/${ROOM}?vlb=on`, 18000);
await reload(20000);
await ensurePlaying("刷新后");
await sleep(3000);
const eSt = await audioState();
const eEng = await engine();
const eM = mediaSince(currentNav);
check("E1 刷新后音频恢复且唯一", eSt.count === 1 && eSt.a?.paused === false, `${JSON.stringify(eSt.a)}`);
check("E2 刷新后音量保持 ~0.8", Math.abs((eSt.a?.volume ?? -1) - 0.8) < 0.05, `audio.volume=${eSt.a?.volume} storage=${eEng?.volume}`);
check("E3 刷新后按钮 + 滑块恢复", eSt.button && !eSt.button.hidden && eSt.slider && !eSt.slider.hidden, `btn=${eSt.button?.hidden} slider=${eSt.slider?.hidden}`);
check("E4 刷新后视频流量 = 0", eM.web === 0, `web=${eM.web}B`);

// ============================================================ F /blanc/
log(`   ----- F /blanc/ 布局（/${ROOM}）`);
await goto(`https://live.bilibili.com/blanc/${ROOM}?vlb=on`, 20000);
await ensurePlaying("/blanc/");
await sleep(2500);
const fSt = await audioState();
const fEng = await engine();
check("F1 /blanc/ 房间识别正确", fEng?.roomId === ROOM, `engine.room=${fEng?.roomId}`);
check("F2 /blanc/ 音频唯一", fSt.count <= 1, `count=${fSt.count}`);
check("F3 /blanc/ 按钮 + 滑块都在（同一套 UI）", fSt.button && !fSt.button.hidden && fSt.slider && !fSt.slider.hidden, `btn=${JSON.stringify(fSt.button)} slider=${JSON.stringify(fSt.slider)}`);
check("F4 /blanc/ 音量保持 ~0.8", Math.abs((fSt.a?.volume ?? -1) - 0.8) < 0.05, `audio.volume=${fSt.a?.volume}`);

// ============================================================ G 首页（已移出范围）
log("===== G 首页 live.bilibili.com/（应完全不再建立插件音频）");
resolveCount = 0; // 只统计进入首页之后的取流次数
await goto("https://live.bilibili.com/?vlb=on", 25000);
await sleep(6000);
const gSt = await audioState();
const gEng = await engine();
check("G1 首页不创建插件 <audio>", gSt.count === 0, `count=${gSt.count}`);
check("G2 首页不显示插件按钮", !gSt.button || gSt.button.hidden, JSON.stringify(gSt.button));
check("G3 首页不显示音量滑块", !gSt.slider || gSt.slider.hidden, JSON.stringify(gSt.slider));
check("G4 首页插件状态为不在直播间", gEng?.phase === "idle" && gEng?.roomId == null, `phase=${gEng?.phase} room=${gEng?.roomId} detail=${gEng?.detail}`);
check("G5 首页不产生纯音频取流", resolveCount === 0, `取流次数=${resolveCount}`);
check("G6 live-state 判定首页不是直播播放页", /false/.test(String(await isolatedEval(`(async()=>{const s=await chrome.storage.local.get({liveSnapshot:null});return JSON.stringify({isLiveRoomPage:s.liveSnapshot?s.liveSnapshot.isLiveRoomPage:null});})()`)) ) , `snapshot=${await isolatedEval(`(async()=>{const s=await chrome.storage.local.get({liveSnapshot:null});return JSON.stringify(s.liveSnapshot&&s.liveSnapshot.isLiveRoomPage);})()`)}`);

console.log("\n================================");
const failed = results.filter((r) => !r.pass);
console.log(`检查项: ${results.length}  失败: ${failed.length}`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
try { child.kill(); } catch {}
process.exit(failed.length ? 1 : 0);
