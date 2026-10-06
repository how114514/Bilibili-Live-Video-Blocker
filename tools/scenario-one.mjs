// 目标明确的场景脚本：每次都全新启动浏览器（不导航），因此执行环境始终稳定。
//
// 用法：
//   node tools/scenario-one.mjs <room> <mode> <port> <extDir> <seedProfile> [holdSec]
//
// mode:
//   on        → 以屏蔽 ON 启动，验证进入直播间后没有视频数据（S1）
//   offon     → 以 OFF 启动，等它播起来后中途开启，验证立即停止（S2/S4）
//   offonoff  → 在 offon 基础上再关闭，验证能恢复播放（S3）
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ROOM = process.argv[2] || "5440";
const MODE = process.argv[3] || "offon";
const PORT = Number(process.argv[4] || 9470);
const EXT_DIR = process.argv[5] || "C:\\Users\\how\\Desktop\\chajian\\extension";
const SEED = process.argv[6] || "temp";
const HOLD_S = Number(process.argv[7] || 20);

let profile;
if (SEED === "temp") profile = mkdtempSync(join(tmpdir(), "edge-one-"));
else {
  profile = mkdtempSync(join(tmpdir(), `edge-one-${basename(SEED)}-`));
  cpSync(SEED, profile, { recursive: true, force: true });
  for (const l of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { rmSync(join(profile, l), { force: true }); } catch {}
  }
}
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startEnabled = MODE === "on";
// 以 ?vlb=on|off 让页面侧在加载时就设定开关（测试入口，走同一条 storage 路径）
const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`,
  `https://live.bilibili.com/${ROOM}?vlb=${startEnabled ? "on" : "off"}&vlbblock=all`,
], { stdio: "ignore" });

let ws = null, msgId = 0;
const pending = new Map();
const events = [];
function send(method, params = {}, sessionId, timeoutMs = 15000) {
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
for (let i = 0; i < 40; i++) {
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
if (!pageSession || !swSession) { log("FAILED: 找不到 target"); process.exit(1); }
await send("Runtime.enable", {}, swSession);
events.length = 0;
await send("Runtime.enable", {}, pageSession);
await sleep(1500);

// 找到主世界执行环境（用魔数确认可写），之后不再导航，环境一直有效
const ctxs = events.filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === pageSession).map((e) => e.params.context);
let mainCtx = null;
for (const c of [...ctxs.filter((x) => x.auxData?.isDefault), ...ctxs.filter((x) => !x.auxData?.isDefault)]) {
  const r = await send("Runtime.evaluate", { expression: "'ok'", returnByValue: true, contextId: c.id }, pageSession);
  if (r?.result?.value === "ok") { mainCtx = c; break; }
}
log(`主世界 ctx=${mainCtx?.id ?? "未找到"}  模式=${MODE}  房间=${ROOM}`);
if (!mainCtx) { log("FAILED: 未找到可用执行环境"); child.kill(); process.exit(1); }

const evalMain = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, contextId: mainCtx.id }, pageSession);
  if (r?.exceptionDetails) return null;
  return r?.result?.value;
};

/**
 * 重新发现主世界执行环境。
 * media-stop.js 在关闭屏蔽时会刷新页面来重建播放器；刷新后旧的 contextId 会失效，
 * 页面的 CDP 会话也可能失效，因此这里必要时重新 attach，再找可用的执行环境。
 */
async function rediscoverMainCtx() {
  const tryFind = async () => {
    events.length = 0;
    await send("Runtime.enable", {}, pageSession);
    await sleep(600);
    const list = events
      .filter((e) => e.method === "Runtime.executionContextCreated" && e.sessionId === pageSession)
      .map((e) => e.params.context);
    for (const c of [...list.filter((x) => x.auxData?.isDefault), ...list.filter((x) => !x.auxData?.isDefault)]) {
      const r = await send("Runtime.evaluate",
        { expression: `(()=>{ try { return typeof document !== 'undefined' && !!document.body ? 'ok' : 'no'; } catch(e){ return 'err'; } })()`,
          returnByValue: true, contextId: c.id }, pageSession);
      if (r?.result?.value === "ok") { mainCtx = c; return true; }
    }
    return false;
  };

  if (await tryFind()) return true;

  // 会话可能因页面刷新而失效：重新 attach 到当前页面 target 再试
  try {
    const list = (await send("Target.getTargets", {})).targetInfos ?? [];
    const pg = list.find((x) => x.type === "page" && x.url.includes("live.bilibili.com"))
      ?? list.find((x) => x.type === "page");
    if (pg) {
      const att = await send("Target.attachToTarget", { targetId: pg.targetId, flatten: true });
      if (att?.sessionId) {
        pageSession = att.sessionId;
        log("    (已重新 attach 页面会话)");
        if (await tryFind()) return true;
      }
    }
  } catch {}
  return false;
}
const swEval = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }, swSession);
  return r?.result?.value;
};

const readState = async () => {
  let v = await evalMain(`JSON.stringify((()=>{
    if (!document || !document.documentElement) return { err: 'no document' };
    const p = window.__VLB_PROBE__;
    const sb = (p && p.sourceBuffers ? p.sourceBuffers : []).reduce((s,b)=>s+(b.appendedBytes||0),0);
    const vs = [...document.querySelectorAll('video')].map(x=>({
      blob: String(x.currentSrc||x.src||'').startsWith('blob:'),
      paused: x.paused, rs: x.readyState, w: x.videoWidth, h: x.videoHeight,
      t: Number(x.currentTime && x.currentTime.toFixed ? x.currentTime.toFixed(2) : x.currentTime),
      src: String(x.currentSrc||'').slice(0,26) }));
    return { sb, live: vs.find(x=>x.blob) || null, videoCount: vs.length,
             probe: typeof window.__VLB_PROBE__, href: location.href,
             bodyLen: document.body ? document.body.innerHTML.length : -1 };
  })())`);
  if (v === null) {
    // 可能是页面刷新导致执行环境失效，重新发现后重试一次
    const ok = await rediscoverMainCtx();
    if (ok) {
      v = await evalMain(`JSON.stringify((()=>{
        const p = window.__VLB_PROBE__;
        const sb = (p && p.sourceBuffers ? p.sourceBuffers : []).reduce((s,b)=>s+(b.appendedBytes||0),0);
        const vs = [...document.querySelectorAll('video')].map(x=>({
          blob: String(x.currentSrc||x.src||'').startsWith('blob:'),
          paused: x.paused, rs: x.readyState, w: x.videoWidth, h: x.videoHeight,
          t: Number(x.currentTime && x.currentTime.toFixed ? x.currentTime.toFixed(2) : x.currentTime),
          src: String(x.currentSrc||'').slice(0,26) }));
        return { sb, live: vs.find(x=>x.blob) || null, videoCount: vs.length,
                 probe: typeof window.__VLB_PROBE__, href: location.href,
                 bodyLen: document.body ? document.body.innerHTML.length : -1 };
      })())`);
    }
  }
  try { return JSON.parse(v); } catch { return null; }
};

/** 读取失败时输出诊断，区分“页面异常”与“读取通道失效”。 */
const readStateDiag = async (label) => {
  const s = await readState();
  if (s === null) {
    const raw = await evalMain("JSON.stringify({href: location.href, ready: document.readyState, vids: document.querySelectorAll('video').length})");
    log(`    [诊断 ${label}] 读取失败；原始返回=${JSON.stringify(raw)}`);
  }
  return s;
};
const ruleCount = () => swEval("return JSON.stringify((await chrome.declarativeNetRequest.getDynamicRules()).length);");
const setEnabled = async (on) => {
  await swEval(`await chrome.storage.local.set({enabled:${on}}); return 1;`);
  await sleep(700);
};

const shot = (label, s) => {
  log(`  ${label}: sb=${s?.sb ?? "null"} live=${JSON.stringify(s?.live ?? null)}`);
  return s ?? null;
};

const out = { room: ROOM, mode: MODE };

if (MODE === "on") {
  // S1: 进入直播间前就开着屏蔽。
  // 注意：SourceBuffer 累计字节不会正好是 0——HLS 清单文本本身也会经过
  // appendBuffer（实测约 1~2 KB）。真正要判定的是：
  //   1) 视频没有在播放
  //   2) 媒体数据不再增长（不再是“黑屏但在下载”）
  await sleep(15000);
  const s1 = shot("ON 进入直播间 15 秒后", await readState());
  await sleep(15000);
  const s2 = shot("再过 15 秒", await readState());
  out.after = s1;
  out.after2 = s2;
  out.ruleCount = await ruleCount();
  out.sbFirst = s1?.sb ?? null;
  out.sbSecond = s2?.sb ?? null;
  out.sbGrowth = (s2?.sb ?? 0) - (s1?.sb ?? 0);
  out.videoPlaying = Boolean(s2?.live && !s2.live.paused && s2.live.rs >= 3);
  // 播放器只追加过清单（KB 级）而非媒体数据（MB 级）
  out.mediaDataAbsent = (s2?.sb ?? 0) < 200 * 1024;
  out.pass = s1 !== null && s2 !== null && !out.videoPlaying && out.sbGrowth === 0 && out.mediaDataAbsent;
  log(`  S1: ${out.pass ? "通过（无视频播放、缓冲零增长、无媒体数据）" : "未通过"}  ` +
      `sb=${out.sbFirst}->${out.sbSecond} 增长=${out.sbGrowth} 播放中=${out.videoPlaying}`);
} else {
  // 先等它播起来（OFF）
  log("  等待视频开始播放...");
  let playing = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const s = await readState();
    if (s?.live && !s.live.paused && s.live.rs >= 3 && s.sb > 0) { playing = s; break; }
    if (i % 5 === 4) log(`    等待中... sb=${s?.sb} live=${JSON.stringify(s?.live ?? null)}`);
  }
  out.before = shot("开启前", playing);
  if (!playing) {
    out.pass = false;
    out.error = "视频未进入播放状态";
    log("  FAILED: 前提不成立");
  } else {
    log("  >>> 中途打开屏蔽");
    await setEnabled(true);
    await sleep(1500);
    const a = shot("开启 1.5 秒后", await readState());
    await sleep(HOLD_S * 1000);
    const b = shot(`再 ${HOLD_S} 秒`, await readState());
    out.afterOn = a;
    out.afterHold = b;
    out.rulesOn = await ruleCount();
    out.sbGrowthAfterOn = (b?.sb ?? 0) - (a?.sb ?? 0);
    out.stillPlaying = Boolean(b?.live && !b.live.paused && b.live.rs >= 3);
    out.S2_pass = out.sbGrowthAfterOn === 0 && !out.stillPlaying;
    log(`  S2: ${out.S2_pass ? "通过（已停止且缓冲零增长）" : "未通过"}`);

    if (MODE === "offonoff") {
      log("  >>> 再关闭屏蔽，观察恢复");
      await setEnabled(false);
      out.rulesOff = await ruleCount();
      let recovered = null;
      const startSb = b?.sb ?? 0;
      for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const cur = await readStateDiag(`S3 第${i + 1}次`);
        if (cur === null) continue;
        log(`    S3 轮询 ${i + 1}: sb=${cur.sb} live=${JSON.stringify(cur.live ?? null)} stopCount=${cur.mediaStop} bodyLen=${cur.bodyLen} 播放中=${Boolean(cur.live && !cur.live.paused && cur.live.rs >= 3)}`);
        const playing = cur.live && !cur.live.paused && cur.live.rs >= 3;
        const grew = (cur.sb ?? 0) > startSb;
        // 播放器重建后 SourceBuffer 计数会归零，所以“恢复”的判据是重新在播放，
        // 而不是缓冲字节一定大于旧值。
        if (playing && (grew || cur.sb > 0)) { recovered = cur; break; }
      }
      out.recovered = shot("关闭后", recovered);
      out.S3_pass = recovered !== null;
      log(`  S3: ${out.S3_pass ? "通过（已恢复播放）" : "未通过（未恢复）"}`);
    }
    out.pass = out.S2_pass && (MODE === "offonoff" ? out.S3_pass : true);
  }
}

log("\n================ 结果 ================");
log(JSON.stringify({ room: ROOM, mode: MODE, pass: out.pass,
  sb: out.sb ?? out.afterHold?.sb ?? null,
  sbGrowthAfterOn: out.sbGrowthAfterOn ?? null,
  videoPlaying: out.videoPlaying ?? out.stillPlaying ?? null }, null, 2));
writeFileSync(`tools/scenario-${MODE}-${ROOM}.json`, JSON.stringify(out, null, 2), "utf8");

try { ws.close(); } catch {}
child.kill();
await sleep(800);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
