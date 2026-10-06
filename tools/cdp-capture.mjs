// Launch Edge with a throwaway profile, load a real Bilibili live room, and
// record every media-ish network request via the Chrome DevTools Protocol.
//
// Connectivity note (measured in this environment): the page-level CDP
// websocket accepts connections but never answers commands here, while the
// browser-level endpoint answers normally. So this script talks to the browser
// endpoint and uses Target.attachToTarget sessions, like Puppeteer does.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ROOM = process.argv[2] || "5440";
const RUN_MS = Number(process.argv[3] || 45) * 1000;
const PORT = Number(process.argv[4] || 9333);
const TAG = process.argv[5] || "baseline";
const EXT_DIR = process.argv[6] || "";

const profile = mkdtempSync(join(tmpdir(), `edge-${TAG}-`));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
log("profile:", profile, EXT_DIR ? `ext=${EXT_DIR}` : "(no extension)");

const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-features=msEdgeSidebarV2",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
if (EXT_DIR) {
  args.push(`--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`);
}
// ?vlb=on / ?vlb=off plus ?vlbblock=<mode> lets an automated run choose the
// toggle position and blocking strategy without a UI click.
const vlbState = process.argv[7] || "off";
const vlbBlockMode = process.argv[8] || "all";
const SAMPLE_MS = Number(process.argv[9] || 2000);
args.push(`https://live.bilibili.com/${ROOM}?vlb=${vlbState}&vlbblock=${vlbBlockMode}`);

const child = spawn(EDGE, args, { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let finished = false;
function shutdown(code) {
  if (finished) return;
  finished = true;
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  setTimeout(() => {
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 700);
}
setTimeout(() => { log("WATCHDOG"); writeReport("watchdog"); shutdown(0); }, RUN_MS + 90000);

// ---------------------------------------------------------------- CDP plumbing
let ws = null;
let msgId = 0;
const pending = new Map();
const bySession = new Map(); // sessionId -> handler(method, params)
const requests = new Map();
const sockets = [];
const consoleErrors = [];

function sendRaw(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return id;
}

function send(method, params = {}, sessionId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const id = sendRaw(method, params, sessionId);
    // Responses are scoped by sessionId: a session-scoped reply carries the
    // sessionId alongside the id, so key the pending entry by both.
    const key = `${sessionId ?? ""}#${id}`;
    const t = setTimeout(() => { pending.delete(key); resolve({ __timeout: true }); }, timeoutMs);
    pending.set(key, (v) => { clearTimeout(t); resolve(v); });
  });
}

function onPageEvent(method, params) {
  switch (method) {
    case "Network.requestWillBeSent":
      requests.set(params.requestId, {
        url: params.request.url, type: params.type, ts: params.timestamp,
        status: null, mime: null, encodedBytes: 0, fromCache: false,
      });
      break;
    case "Network.responseReceived": {
      const r = requests.get(params.requestId);
      if (r) {
        r.status = params.response.status;
        r.mime = params.response.mimeType;
        r.fromCache = !!params.response.fromDiskCache;
        r.contentLength = params.response.headers?.["content-length"] ?? null;
        r.remoteURL = params.response.url;
      }
      break;
    }
    case "Network.loadingFinished": {
      const r = requests.get(params.requestId);
      if (r) r.encodedBytes = params.encodedDataLength;
      break;
    }
    case "Network.loadingFailed": {
      const r = requests.get(params.requestId);
      if (r) { r.failed = params.errorText; r.blockedReason = params.blockedReason; }
      break;
    }
    case "Network.webSocketCreated":
      sockets.push(params.url);
      break;
    case "Runtime.consoleAPICalled":
      if (params.type === "error") {
        consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 220));
      }
      break;
    case "Runtime.exceptionThrown":
      consoleErrors.push("EXC: " + (params.exceptionDetails?.exception?.description ?? "").slice(0, 220));
      break;
  }
}

// ---------------------------------------------------------------- connect
let version = null;
let target = null;
for (let i = 0; i < 45 && !version; i++) {
  await sleep(1000);
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
  } catch {}
}
if (!version) { log("FAILED: browser endpoint never came up"); writeReport("no-browser"); shutdown(1); }

log("browser:", version.Browser);
ws = new WebSocket(version.webSocketDebuggerUrl);

await new Promise((resolve) => {
  const t = setTimeout(() => { log("WS open timeout"); resolve(); }, 12000);
  ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
  ws.addEventListener("error", () => { clearTimeout(t); resolve(); });
});
log("ws readyState:", ws.readyState);

ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(`${msg.sessionId ?? ""}#${msg.id}`)) {
    const key = `${msg.sessionId ?? ""}#${msg.id}`;
    pending.get(key)(msg.result ?? msg.error ?? {});
    pending.delete(key);
    return;
  }
  if (!msg.method) return;
  if (msg.sessionId && bySession.has(msg.sessionId)) bySession.get(msg.sessionId)(msg.method, msg.params);
});

// find the live.bilibili.com page target
for (let i = 0; i < 40 && !target; i++) {
  const res = await send("Target.getTargets", {});
  const list = res?.targetInfos ?? [];
  target =
    list.find((t) => t.type === "page" && t.url.includes(`/${ROOM}`)) ||
    list.find((t) => t.type === "page" && t.url.includes("live.bilibili.com")) ||
    list.find((t) => t.type === "page");
  if (!target) await sleep(1000);
}
if (!target) { log("FAILED: no page target"); writeReport("no-target"); shutdown(1); }
log("page target:", target.url);

const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
const sessionId = attached?.sessionId;
if (!sessionId) { log("FAILED: attach failed", JSON.stringify(attached).slice(0, 200)); writeReport("no-session"); shutdown(1); }
bySession.set(sessionId, onPageEvent);
log("attached session:", sessionId.slice(0, 12));

const netOn = await send("Network.enable", { maxTotalBufferSize: 2e8, maxResourceBufferSize: 5e7 }, sessionId);
log("Network.enable ->", netOn?.__timeout ? "TIMEOUT" : "ok");
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);

// ---------------------------------------------------------------- record
log(`recording ${RUN_MS / 1000}s ...`);
const samples = [];
const probeExpr = `JSON.stringify((()=>{
  const mediaRe=/bilivideo|live-bvc|\\.flv|\\.m3u8|\\.m4s|\\.ts(\\?|$)/;
  const rs=performance.getEntriesByType('resource').filter(e=>mediaRe.test(e.name));
  const vs=[...document.querySelectorAll('video')];
  return {
    mediaReqs: rs.length,
    mediaBytes: rs.reduce((s,e)=>s+(e.transferSize||0),0),
    videos: vs.map(v=>({rs:v.readyState,ns:v.networkState,w:v.videoWidth,h:v.videoHeight,
      paused:v.paused,err:v.error?v.error.code:null,cur:(v.currentSrc||'').slice(0,80),
      buf:v.buffered.length?+v.buffered.end(0).toFixed(1):null})),
    audio:[...document.querySelectorAll('audio')].map(a=>({rs:a.readyState,paused:a.paused})),
    audioCtx:[...document.querySelectorAll('video,audio')].length,
    sourceBuffers:(window.__VLB_PROBE__?.sourceBuffers??[]).map(b=>({mime:b.mime,bytes:b.appendedBytes,calls:b.appendCalls,err:b.error})),
    sbAppendedTotal:(window.__VLB_PROBE__?.sourceBuffers??[]).reduce((s,b)=>s+b.appendedBytes,0),
  };})())`;

const deadline = Date.now() + RUN_MS;
while (Date.now() < deadline) {
  await sleep(SAMPLE_MS);
  const res = await send("Runtime.evaluate", { expression: probeExpr, returnByValue: true }, sessionId, 12000);
  const v = res?.result?.value;
  if (v) { try { samples.push({ sec: Math.round((RUN_MS - (deadline - Date.now())) / 1000), ...JSON.parse(v) }); } catch {} }
}

// ---------------------------------------------------------------- final probe
const finalExpr = `JSON.stringify((()=>{
  const mediaRe=/bilivideo|live-bvc|\\.flv|\\.m3u8|\\.m4s|\\.ts(\\?|$)/;
  const rs=performance.getEntriesByType('resource').filter(e=>mediaRe.test(e.name));
  const vs=[...document.querySelectorAll('video')];
  return {href:location.href,title:document.title,videoCount:vs.length,
    videos:vs.map(v=>({src:(v.src||'').slice(0,160),currentSrc:(v.currentSrc||'').slice(0,160),
      readyState:v.readyState,networkState:v.networkState,duration:v.duration,paused:v.paused,
      videoWidth:v.videoWidth,videoHeight:v.videoHeight,error:v.error?v.error.code:null,
      buffered:v.buffered.length?[v.buffered.start(0),v.buffered.end(0)]:null})),
    mediaResourceCount:rs.length,
    mediaTransferTotal:rs.reduce((s,e)=>s+(e.transferSize||0),0),
    mediaSample:rs.slice(-25).map(e=>({n:e.name.slice(0,140),size:e.transferSize}))};})())`;
const finalRes = await send("Runtime.evaluate", { expression: finalExpr, returnByValue: true }, sessionId, 15000);
let finalSnap = null;
try { finalSnap = JSON.parse(finalRes.result.value); } catch { finalSnap = { raw: finalRes }; }

writeReport("done", { sessionId, finalSnap, samples });
log(`[saved] tools/capture-${TAG}.json`);
shutdown(0);

// ---------------------------------------------------------------- reporting
function writeReport(reason, extra = {}) {
  const media = [...requests.values()].filter(
    (r) => /bilivideo|live-bvc|\.flv|\.m3u8|\.m4s|\.ts(\?|$)/.test(r.url) ||
      r.type === "Media" || (r.mime ?? "").startsWith("video/") || (r.mime ?? "").startsWith("audio/"),
  );
  const mimeHistogram = {};
  for (const r of media) mimeHistogram[r.mime ?? "?"] = (mimeHistogram[r.mime ?? "?"] ?? 0) + 1;
  const blocked = media.filter((r) => r.failed);
  const report = {
    tag: TAG, room: ROOM, reason, extensionDir: EXT_DIR || null,
    finalSnapshot: extra.finalSnap ?? null,
    samples: extra.samples ?? [],
    mimeHistogram,
    mediaRequestCount: media.length,
    mediaTotalEncodedBytes: media.reduce((s, r) => s + (r.encodedBytes || 0), 0),
    blockedMediaRequestCount: blocked.length,
    blockedMediaRequests: blocked.map((r) => ({ failed: r.failed, blockedReason: r.blockedReason, url: r.url.slice(0, 200) })),
    mediaRequests: media.map((r) => ({
      type: r.type, status: r.status, mime: r.mime, bytes: r.encodedBytes,
      failed: r.failed ?? null, url: r.url.slice(0, 260),
    })),
    websockets: sockets.map((s) => s.slice(0, 180)),
    consoleErrors: consoleErrors.slice(0, 30),
  };
  writeFileSync(`tools/capture-${TAG}.json`, JSON.stringify(report, null, 2), "utf8");
  log(`RESULT tag=${TAG} reason=${reason} mediaReqs=${report.mediaRequestCount} blocked=${blocked.length} bytes=${report.mediaTotalEncodedBytes} ws=${sockets.length}`);
  log(`mime: ${JSON.stringify(mimeHistogram)}`);
  if (extra.finalSnap?.videos) log(`video: ${JSON.stringify(extra.finalSnap.videos).slice(0, 300)}`);
  if (extra.samples?.length) {
    log("timeline (sec, mediaReqs, mediaBytes, sourceBufferBytes, videoReadyState):");
    for (const s of extra.samples) {
      log(
        `   t=${s.sec}s reqs=${s.mediaReqs} bytes=${s.mediaBytes} sb=${s.sbAppendedTotal ?? 0} ` +
          `v=${JSON.stringify(s.videos)} sbMimes=${JSON.stringify((s.sourceBuffers ?? []).map((b) => b.mime))}`,
      );
    }
  }
}
