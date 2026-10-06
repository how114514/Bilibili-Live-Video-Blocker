// 专注验证一件事：ON -> OFF 之后，直播视频能否恢复播放。
//
// 做法：以 vlb=off 启动（页面侧会写 storage enabled=false），
// 加载后手动开启屏蔽（视频应停止），再关闭屏蔽，然后观察视频是否重新播放。
// 页面若因恢复逻辑刷新，脚本会重新 attach 并继续观察。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ROOM = process.argv[2] || "5440";
const PORT = Number(process.argv[3] || 9480);
const EXT_DIR = process.argv[4] || "C:\\Users\\how\\Desktop\\chajian\\extension";
const SEED = process.argv[5] || "temp";
const WATCH_S = Number(process.argv[6] || 40);

let profile;
if (SEED === "temp") profile = mkdtempSync(join(tmpdir(), "edge-rec-"));
else {
  profile = mkdtempSync(join(tmpdir(), `edge-rec-${basename(SEED)}-`));
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
  "--disable-renderer-backgrounding",
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

async function attachAll() {
  for (let i = 0; i < 30; i++) {
    const list = (await send("Target.getTargets", {})).targetInfos ?? [];
    const sw = list.find((x) => x.type === "service_worker" && /background\/service-worker\.js/.test(x.url));
    const pg = list.find((x) => x.type === "page" && x.url.includes("live.bilibili.com"));
    if (sw && pg) {
      const swS = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
      const pgS = await send("Target.attachToTarget", { targetId: pg.targetId, flatten: true });
      return { swSession: swS?.sessionId, pageSession: pgS?.sessionId };
    }
    await sleep(1000);
  }
  return {};
}
let { swSession, pageSession } = await attachAll();
if (!pageSession) { log("no targets"); process.exit(1); }
await send("Runtime.enable", {}, swSession);

// 每次读取都重新发现执行环境（页面刷新后依然可用），避免 contextId 失效问题。
// Runtime.enable 之后执行环境事件是异步到达的，因此这里重试几次，避免竞态读到 null。
async function readStateOnce() {
  const ctxs = events
    .filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === pageSession)
    .map((e) => e.params.context);
  for (const c of [...ctxs.filter((x) => x.auxData?.isDefault), ...ctxs.filter((x) => !x.auxData?.isDefault)]) {
    const r = await send("Runtime.evaluate", {
      expression: `JSON.stringify((()=>{
        const p = window.__VLB_PROBE__;
        const sb = (p && p.sourceBuffers ? p.sourceBuffers : []).reduce((s,b)=>s+(b.appendedBytes||0),0);
        const vs = [...document.querySelectorAll('video')].map(x=>({
          blob: String(x.currentSrc||x.src||'').startsWith('blob:'), paused: x.paused,
          rs: x.readyState, w: x.videoWidth, t: Number(x.currentTime && x.currentTime.toFixed ? x.currentTime.toFixed(2) : x.currentTime) }));
        return { sb, live: vs.find(x=>x.blob) || null, href: location.href, videoCount: vs.length };
      })())`,
      returnByValue: true, contextId: c.id,
    }, pageSession, 8000);
    if (r?.result?.value) {
      try { return JSON.parse(r.result.value); } catch {}
    }
  }
  return null;
}

/**
 * 通过页面级 websocket 直接读取页面状态。
 *
 * 背景：在扩展把播放器拆掉的那一刻，通过 browser 级 session 发 Runtime.enable
 * 会出现超时；而页面级 websocket 是直接连到该页面 target 的，更可靠。
 * 这里为每次读取新建一个短连接，读完即关。
 */
async function readViaPageSocket() {
  let wsUrl = null;
  for (let i = 0; i < 5 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
      const pg = list.find((t) => t.type === "page" && t.url.includes("live.bilibili.com")) ?? list.find((t) => t.type === "page");
      wsUrl = pg?.webSocketDebuggerUrl ?? null;
    } catch {}
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) return null;

  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(v); } };
    const sock = new WebSocket(wsUrl);
    const timer = setTimeout(() => finish(null), 9000);
    sock.addEventListener("error", () => { clearTimeout(timer); finish(null); });
    sock.addEventListener("open", () => {
      sock.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate",
        params: {
          expression: `JSON.stringify((()=>{
            const p = window.__VLB_PROBE__;
            const sb = (p && p.sourceBuffers ? p.sourceBuffers : []).reduce((s,b)=>s+(b.appendedBytes||0),0);
            const vs = [...document.querySelectorAll('video')].map(x=>({
              blob: String(x.currentSrc||x.src||'').startsWith('blob:'), paused: x.paused,
              rs: x.readyState, w: x.videoWidth, t: Number(x.currentTime && x.currentTime.toFixed ? x.currentTime.toFixed(2) : x.currentTime) }));
            return { sb, live: vs.find(x=>x.blob) || null, href: location.href };
          })())`,
          returnByValue: true,
        },
      }));
    });
    sock.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { finish(JSON.parse(m.result.result.value)); } catch { finish(null); }
    });
  });
}

async function readState(retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const s = await readViaPageSocket();
    if (s) return s;
    await sleep(800);
  }
  return null;
}

const swEval = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }, swSession);
  return r?.result?.value;
};

const out = { room: ROOM, steps: [] };
const record = (label, s) => {
  log(`  ${label}: sb=${s?.sb ?? "null"} live=${JSON.stringify(s?.live ?? null)} href=${String(s?.href ?? "").slice(-40)}`);
  out.steps.push({ label, ...(s ?? { null: true }) });
  return s;
};

// 等视频播放起来
log("等待视频开始播放（OFF）...");
let playing = null;
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  const s = await readState();
  if (s?.live && !s.live.paused && s.live.rs >= 3) { playing = s; break; }
  if (i % 5 === 4) log(`  等待中... ${JSON.stringify(s?.live ?? null)}`);
}
record("播放中(OFF)", playing);
if (!playing) { log("FAILED: 视频未播放"); child.kill(); process.exit(1); }

/** 开启屏蔽并确认视频停止；返回 [开启后状态, 停止是否成立] */
async function enableAndCheck(label, holdMs = 6000) {
  log(`>>> 开启屏蔽（${label}）`);
  await swEval("await chrome.storage.local.set({enabled:true}); return 1;");
  await sleep(2000);
  const a = record(`${label}:开启后`, await readState());
  await sleep(holdMs);
  const b = record(`${label}:再 ${holdMs / 1000} 秒`, await readState());
  const stopped = Boolean(b?.live && (b.live.paused || b.live.rs === 0) && (b.sb ?? -1) === (a?.sb ?? -2));
  return { a, b, stopped };
}

/** 关闭屏蔽并等待恢复 */
async function disableAndWaitRecovery(label, maxSec = 45) {
  log(`>>> 关闭屏蔽（${label}），等待恢复`);
  await swEval("await chrome.storage.local.set({enabled:false}); return 1;");
  await sleep(3000);
  let recovered = null;
  let reloaded = false;
  const hrefBefore = (await readState())?.href ?? "";
  for (let i = 0; i < maxSec / 3; i++) {
    const s = await readState();
    if (s === null) { reloaded = true; continue; }
    if (s.href !== hrefBefore) reloaded = true;
    log(`  ${label} 恢复观察 +${(i + 1) * 3}s: sb=${s.sb} live=${JSON.stringify(s.live ?? null)}`);
    if (s.live && !s.live.paused && s.live.rs >= 3 && s.sb > 0) { recovered = s; break; }
    await sleep(3000);
  }
  record(`${label}:恢复后`, recovered);
  return { recovered, reloaded };
}

// ---- 第 1 轮：OFF -> ON
const round1 = await enableAndCheck("第1轮");
out.stopped1 = round1.stopped;

// ---- ON -> OFF（应恢复）
const rec1 = await disableAndWaitRecovery("第1轮关闭");
out.recovered1 = rec1.recovered !== null;
out.reload1 = rec1.reloaded;

// ---- 再 OFF -> ON（第 2 轮，验证恢复后还能再次停止）
if (rec1.recovered) {
  const round2 = await enableAndCheck("第2轮");
  out.stopped2 = round2.stopped;
  // ---- 再 ON -> OFF（第 2 轮恢复）
  const rec2 = await disableAndWaitRecovery("第2轮关闭");
  out.recovered2 = rec2.recovered !== null;
  out.reload2 = rec2.reloaded;
} else {
  out.stopped2 = false;
  out.recovered2 = false;
  log("  (第1轮未恢复，跳过第2轮)");
}

out.pass = out.stopped1 && out.recovered1 && out.stopped2 && out.recovered2;
log(`\n结论：`);
log(`  第1轮 开启后停止        = ${out.stopped1}`);
log(`  第1轮 关闭后恢复        = ${out.recovered1} (刷新=${out.reload1})`);
log(`  第2轮 开启后停止        = ${out.stopped2}`);
log(`  第2轮 关闭后恢复        = ${out.recovered2} (刷新=${out.reload2})`);
log(`  总体：${out.pass ? "通过（开关在开关两个方向都可反复生效）" : "未通过"}`);

writeFileSync("tools/verify-recovery.json", JSON.stringify(out, null, 2), "utf8");
try { ws.close(); } catch {}
child.kill();
await sleep(800);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
