/**
 * service-worker.js 单元自检（无需浏览器）。
 *
 * 重点验证本次修复引入的关键行为：
 *   写入 storage（enabled / blockMode）必须驱动 DNR 动态规则同步，
 *   而不是只有 popup 发来的 setEnabled 消息才生效。
 *
 * 做法：用桩替换 globalThis.chrome / fetch，然后真实 import 该 ES module。
 * 运行：node tools/selfcheck-serviceworker.mjs
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let checks = 0;
let failures = 0;
const record = (ok, label, extra = "") => {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ""}`);
  }
};

// ------------------------------------------------------------------ 桩
let dynamicRules = [];
let stored = { enabled: false, blockMode: "all", blockedCount: 0, firstBlockedAt: null };
const listeners = { storage: [], message: null, installed: [], startup: [] };
let updateCalls = 0;

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        return { ...defaults, ...stored };
      },
      async set(patch) {
        stored = { ...stored, ...patch };
      },
    },
    onChanged: {
      addListener(fn) {
        listeners.storage.push(fn);
      },
    },
  },
  declarativeNetRequest: {
    async getDynamicRules() {
      return dynamicRules.map((r) => ({ ...r }));
    },
    async updateDynamicRules({ removeRuleIds, addRules }) {
      updateCalls++;
      const remove = new Set(removeRuleIds ?? []);
      dynamicRules = dynamicRules.filter((r) => !remove.has(r.id)).concat(addRules ?? []);
    },
    async getMatchedRules() {
      return { rulesMatchedInfo: [] };
    },
    async setMatchedRules() {},
  },
  runtime: {
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => (listeners.message = fn) },
  },
};

// 没有本地收集器时验证覆写必须失效
globalThis.fetch = async () => {
  throw new Error("no collector");
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 加载模块
const modUrl = pathToFileURL(resolve("extension/background/service-worker.js")).href;
await import(modUrl);
await wait(300); // 等 bootstrap 跑完
if (listeners.storage.length !== 1) {
  console.log(`(debug) 期望注册 1 个 storage 监听，实际 ${listeners.storage.length}`);
}

console.log("== 1. 初始状态 ==");
record(dynamicRules.length === 0, "默认（关闭）状态下不应该有动态规则", JSON.stringify(dynamicRules));
record(stored.enabled === false, "默认 enabled 应为 false");

console.log("\n== 2. 只有 storage 变更时，规则必须跟着变（本次修复的核心） ==");
/**
 * 模拟真实的 chrome.storage.onChanged：先真正写入存储，再派发变更事件。
 * （不能只派发事件而不写存储，否则监听器读到的仍是旧值。）
 */
const fireStorage = async (changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) stored[key] = newValue;
  for (const fn of listeners.storage) fn(changes, "local");
  await wait(150);
};

await fireStorage({ enabled: { oldValue: false, newValue: true } });
// V2：开启后应有两条规则——一条拦直播媒体，一条放行插件自己的纯音频流。
record(dynamicRules.length === 2, "写 storage enabled=true 后规则没有生效", `规则数=${dynamicRules.length}`);
const blockRule = dynamicRules.find((r) => r.action?.type === "block");
const allowRule = dynamicRules.find((r) => r.action?.type === "allow");
record(
  /live-bvc/.test(blockRule?.condition?.regexFilter ?? ""),
  "拦截规则没有使用 /live-bvc/ 判据",
  String(blockRule?.condition?.regexFilter),
);
record(
  Boolean(allowRule) && /pt=android/.test(allowRule?.condition?.regexFilter ?? ""),
  "缺少 V2 纯音频放行规则，或判据不是 pt=android",
  JSON.stringify(allowRule),
);
record(
  (allowRule?.priority ?? 0) > (blockRule?.priority ?? 0),
  "放行规则优先级必须高于拦截规则，否则插件自己的音频也会被拦掉",
  `block=${blockRule?.priority} allow=${allowRule?.priority}`,
);
console.log(`  拦截规则: ${blockRule?.condition?.regexFilter}`);
console.log(`  放行规则: ${allowRule?.condition?.regexFilter}`);

await fireStorage({ enabled: { oldValue: true, newValue: false } });
record(dynamicRules.length === 0, "写 storage enabled=false 后规则没有撤销", `规则数=${dynamicRules.length}`);

console.log("\n== 3. blockMode 变更也要同步 ==");
stored.enabled = true;
await fireStorage({ blockMode: { oldValue: "all", newValue: "segments" } });
const segRule = dynamicRules[0]?.condition?.regexFilter ?? "";
record(/m4s|ts|flv/.test(segRule) && !/m3u8/.test(segRule), "segments 策略的规则不正确", segRule);
console.log(`  segments 规则: ${segRule}`);

console.log("\n== 4. popup 的 setEnabled 消息路径仍然可用 ==");
stored.enabled = false;
dynamicRules = [];
record(typeof listeners.message === "function", "service worker 未注册 onMessage 监听");
if (listeners.message) {
  const response = await new Promise((resolve) => {
    const keep = listeners.message({ type: "setEnabled", enabled: true }, {}, resolve);
    if (!keep) resolve(null);
  });
  await wait(200);
  record(response?.enabled === true, "setEnabled 响应缺少 enabled", JSON.stringify(response));
  record(dynamicRules.length === 2, "setEnabled 之后规则未生效", `规则数=${dynamicRules.length}`);
  record(stored.enabled === true, "setEnabled 之后 storage 未更新");
}

console.log("\n== 5. getState / resetStats 仍然可用 ==");
if (listeners.message) {
  const state = await new Promise((r) => listeners.message({ type: "getState" }, {}, r));
  record(state && typeof state.enabled === "boolean", "getState 返回异常", JSON.stringify(state));
  record(typeof state?.liveStreamPath === "string", "getState 缺少 liveStreamPath");
  stored.blockedCount = 42;
  const reset = await new Promise((r) => listeners.message({ type: "resetStats" }, {}, r));
  await wait(120);
  record(stored.blockedCount === 0, "resetStats 没有清零 blockedCount", String(stored.blockedCount));
  record(reset && reset.blockedCount === 0, "resetStats 响应异常");
}

console.log("\n== 6. 未知消息要报错而不是静默 ==");
if (listeners.message) {
  const bad = await new Promise((r) => listeners.message({ type: "nope" }, {}, r));
  record(Boolean(bad?.error), "未知消息类型没有返回 error", JSON.stringify(bad));
}

console.log("\n== 7. V2 取流路径（resolveAudioStream） ==");
if (listeners.message) {
  const ask = (roomId) => new Promise((r) => listeners.message({ type: "resolveAudioStream", roomId }, {}, r));

  // 房间号非法时必须直接拒绝，不能打到 B站接口
  let fetchCalled = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled++;
    throw new Error("should not be called");
  };
  const bad = await ask("abc");
  record(bad?.ok === false && fetchCalled === 0, "非法房间号应直接拒绝且不发请求", JSON.stringify(bad));

  // 接口不可用时要如实返回错误，而不是抛出去
  const offline = await ask("6");
  record(offline?.ok === false && typeof offline.error === "string", "接口失败时应返回 ok:false + error", JSON.stringify(offline));

  // 正常响应：应当从 http_stream/flv 里挑出地址，并带上 expires
  const APP_URL =
    "https://d1--cn-gotcha07.bilivideo.com/live-bvc/896936/live_50329118_9516950_2500.flv?expires=1791217638&pt=android&ptype=1&cdn=cn-gotcha01&upsig=abc";
  const playInfo = {
    code: 0,
    message: "OK",
    data: {
      live_status: 1,
      playurl_info: {
        playurl: {
          stream: [
            { protocol_name: "http_hls", format: [{ format_name: "fmp4", codec: [{ base_url: "/live-bvc/1/x/index.m3u8?", url_info: [{ host: "https://cdn.example", extra: "pt=android" }] }] }] },
            { protocol_name: "http_stream", format: [{ format_name: "flv", codec: [{ base_url: "/live-bvc/896936/live_50329118_9516950_2500.flv?", url_info: [{ host: "https://d1--cn-gotcha07.bilivideo.com", extra: APP_URL.split("?")[1] }], session: "live_50329118_9516950" }] }] },
          ],
        },
      },
    },
  };

  globalThis.fetch = async (url) => {
    fetchCalled++;
    record(String(url).includes("only_audio=1"), "取流请求必须带 only_audio=1", String(url));
    record(String(url).includes("room_id=6"), "取流请求必须带 room_id", String(url));
    return { ok: true, status: 200, json: async () => playInfo };
  };
  fetchCalled = 0;
  const good = await ask("6");
  record(good?.ok === true, "正常响应应当返回 ok:true", JSON.stringify(good));
  record(good?.url === APP_URL, "取到的 URL 不正确（应为 host + base_url + extra）", String(good?.url));
  record(good?.expiresAt === 1791217638, "没有带出 expires", String(good?.expiresAt));
  record(String(good?.url ?? "").includes("/live-bvc/") && String(good?.url ?? "").includes(".flv"), "取到的不是 FLV 地址", String(good?.url));

  // 未开播要有明确说法
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { live_status: 0 } }) });
  const off = await ask("6");
  record(off?.ok === false && /未开播/.test(off.error ?? ""), "未开播房间应明确报“未开播”", JSON.stringify(off));

  globalThis.fetch = realFetch;
}

console.log(`\n  (规则更新调用次数: ${updateCalls})`);
console.log("\n================================");
console.log(`检查项: ${checks}  失败: ${failures}`);
console.log(failures === 0 ? "结果: 全部通过" : "结果: 存在失败项");
process.exit(failures === 0 ? 0 : 1);
