/**
 * media-stop.js 单元自检（无需浏览器）。
 *
 * 在最小 DOM 桩里真实执行 media-stop.js，验证三件事：
 *   1. 直播媒体（blob: 源）会被真正终止：pause + 清 src + load
 *   2. 直播间的宣传小挂件（直链 mp4）不会被误伤
 *   3. 开关关闭时不动作；开启时即时动作；后插入的播放器也会被抓到
 *
 * 运行：node tools/selfcheck-mediastop.mjs
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync("extension/content/media-stop.js", "utf8");

let checks = 0;
let failures = 0;
const record = (ok, label, extra = "") => {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${label}${extra ? `\n        ${extra}` : ""}`);
  }
};

// ------------------------------------------------------------------ DOM 桩
class FakeVideo {
  constructor({ src = "", srcObject = null, paused = false, readyState = 4, children = [] } = {}) {
    this.tagName = "VIDEO";
    this._src = src;
    this._currentSrc = src;
    this.srcObject = srcObject;
    this.paused = paused;
    this.readyState = readyState;
    this.currentTime = 12.5;
    this.children = children;
    this._children = children;
    this.loadCalls = 0;
    this.pauseCalls = 0;
    this.removedAttrs = [];
    this.ownerDocument = null; // 由 harness 注入
    // src 属性：load() 之后浏览器会认为没有取源，currentSrc 为空
    Object.defineProperty(this, "src", {
      get: () => this._src,
      set: (v) => {
        this._src = v;
      },
      configurable: true,
    });
    Object.defineProperty(this, "currentSrc", { get: () => this._currentSrc, configurable: true });
  }
  pause() {
    this.pauseCalls++;
    this.paused = true;
  }
  load() {
    this.loadCalls++;
    this._currentSrc = ""; // 真实浏览器在 load() 后重新解析源，这里已无源
    this.readyState = 0;
  }
  removeAttribute(name) {
    this.removedAttrs.push(name);
    if (name === "src") this._src = "";
  }
  querySelector(sel) {
    if (sel !== "source") return null;
    return this._children.find((c) => c.tagName === "SOURCE") ?? null;
  }
  get childrenList() {
    return this._children;
  }
}

// FakeVideo.children 需要支持展开与 remove()
function makeChild(tag) {
  return { tagName: tag, remove() {} };
}

function createHarness({ videos = [], enabled = false, href = "https://live.bilibili.com/1" } = {}) {
  const listeners = {};
  const intervals = [];
  const rafQueue = [];
  const observers = [];
  const timeouts = [];
  const reloadCalls = { count: 0 };

  const documentStub = {
    querySelectorAll(sel) {
      if (sel === "video") return videos;
      return [];
    },
    documentElement: {},
    addEventListener() {},
  };
  for (const v of videos) v.ownerDocument = documentStub;

  const chromeStub = {
    storage: {
      local: { get: async () => ({ enabled }) },
      onChanged: {
        addListener(fn) {
          listeners.storageChanged = fn;
        },
      },
    },
  };

  const context = {
    document: documentStub,
    HTMLVideoElement: FakeVideo,
    // 忠实一点的桩：observe() 之后记录回调，由 notifyMutation() 触发，
    // 模拟真实浏览器在 DOM 变化时调用观察者。
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.observing = false;
        observers.push(this);
      }
      observe() {
        this.observing = true;
      }
      disconnect() {
        this.observing = false;
      }
    },
    requestAnimationFrame: (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    // 定时器收集起来由测试手动触发，避免依赖真实时钟
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout: () => {},
    console,
    location: {
      get href() {
        return href;
      },
      reload() {
        reloadCalls.count++;
      },
    },
    chrome: chromeStub,
    window: {
      addEventListener() {},
    },
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: "media-stop.js" });

  // 触发 raf 队列
  const flushRaf = () => {
    while (rafQueue.length) rafQueue.shift()();
  };
  // 触发所有已排队的 setTimeout
  const flushTimeouts = () => {
    while (timeouts.length) timeouts.shift().fn();
  };

  return {
    context,
    videos,
    flushRaf,
    flushTimeouts,
    intervals,
    observers,
    reloadCalls,
    observersCount: () => observers.length,
    /** 模拟 DOM 发生插入：真实浏览器会调用已注册的 MutationObserver 回调。 */
    notifyMutation: () => {
      for (const o of observers) if (o.observing) o.cb([]);
    },
    fireStorageChange: (newValue) => listeners.storageChanged?.({ enabled: { newValue } }, "local"),
    /** 模拟播放器重建：插入一个新的直播 video，并触发 DOM 变化通知。 */
    addLiveVideo: (opts) => {
      const v = new FakeVideo({ src: "blob:https://live.bilibili.com/new", ...opts });
      v.ownerDocument = documentStub;
      videos.push(v);
      return v;
    },
  };
}

const LIVE_SRC = "blob:https://live.bilibili.com/1b1703ea-0307-4b3c-b657-c667353741e6";
const PROMO_SRC = "https://i0.hdslb.com/bfs/live/bc806d6cf2c2a8178bd7f2aea086a1de1765b5bf.mp4";

// ---------------------------------------------------------------- 场景 1
console.log("== 场景 1：开关关闭时不得动作 ==");
{
  const live = new FakeVideo({ src: LIVE_SRC });
  const promo = new FakeVideo({ src: PROMO_SRC });
  const h = createHarness({ videos: [live, promo], enabled: false });
  await new Promise((r) => setTimeout(r, 10)); // 等 storage.get 的 promise
  h.flushRaf();
  h.intervals.forEach((i) => i.fn());
  record(live.pauseCalls === 0, "关闭状态下错误地暂停了直播视频");
  record(live.loadCalls === 0, "关闭状态下错误地 load() 了直播视频");
  record(promo.pauseCalls === 0, "关闭状态下动了宣传视频");
}

// ---------------------------------------------------------------- 场景 2
console.log("\n== 场景 2：已开播时打开开关 → 立即终止直播媒体，且不误伤宣传挂件 ==");
{
  const live = new FakeVideo({ src: LIVE_SRC, paused: false });
  const promo = new FakeVideo({ src: PROMO_SRC, paused: false });
  const h = createHarness({ videos: [live, promo], enabled: false });
  await new Promise((r) => setTimeout(r, 10));
  h.flushRaf();

  // 观看中，用户点开开关
  h.fireStorageChange(true);

  record(live.pauseCalls >= 1, "开关打开后没有暂停正在播放的直播视频");
  record(live.loadCalls >= 1, "开关打开后没有调用 load() 释放媒体资源");
  record(live.removedAttrs.includes("src"), "没有清空直播视频的 src");
  record(live.currentSrc === "", "直播视频仍然持有 currentSrc");
  record(live.paused === true, "直播视频仍在播放状态");

  record(promo.pauseCalls === 0, "误伤了宣传挂件（被暂停）");
  record(promo.loadCalls === 0, "误伤了宣传挂件（被 load）");
  record(promo.currentSrc === PROMO_SRC, "宣传挂件的 src 被错误清空");
}

// ---------------------------------------------------------------- 场景 3
console.log("\n== 场景 3：播放器是异步创建的，开关已开时后插入也要被抓到 ==");
{
  const h = createHarness({ videos: [], enabled: true });
  await new Promise((r) => setTimeout(r, 10));
  h.flushRaf();

  const later = h.addLiveVideo({ paused: false });
  h.notifyMutation(); // 真实浏览器在插入时会触发观察者
  h.flushRaf();
  record(later.pauseCalls >= 1, "后插入的直播视频没有被终止");
  record(later.currentSrc === "", "后插入的直播视频 src 未清空");
}

// ---------------------------------------------------------------- 场景 4
console.log("\n== 场景 4：兜底轮询能在没有 DOM 变化时复查（播放器重建了 src） ==");
{
  const live = new FakeVideo({ src: LIVE_SRC, paused: false });
  const h = createHarness({ videos: [live], enabled: true });
  await new Promise((r) => setTimeout(r, 10));
  h.flushRaf();
  const afterFirst = live.loadCalls;
  record(afterFirst >= 1, "开关已开但首次未终止");

  // 模拟播放器自行把 src 抢回来
  live._src = LIVE_SRC;
  live._currentSrc = LIVE_SRC;
  live.paused = false;
  h.intervals.forEach((i) => i.fn()); // 触发 500ms 兜底
  record(live.loadCalls > afterFirst, "播放器抢回 src 后兜底轮询没有再次终止");
  record(live.currentSrc === "", "兜底轮询后 src 仍未清空");
}

// ---------------------------------------------------------------- 场景 5
console.log("\n== 场景 5：关闭开关后不再持续干预（便于 OFF 恢复正常） ==");
{
  const live = new FakeVideo({ src: LIVE_SRC, paused: false });
  const h = createHarness({ videos: [live], enabled: true });
  await new Promise((r) => setTimeout(r, 10));
  h.flushRaf();
  const afterOn = live.loadCalls;

  h.fireStorageChange(false);
  const afterOff = live.loadCalls;
  h.flushRaf();
  h.intervals.forEach((i) => i.fn());
  record(live.loadCalls === afterOff, "关闭后仍在继续终止媒体", `on=${afterOn} off=${afterOff} now=${live.loadCalls}`);
}

// ---------------------------------------------------------------- 场景 6
console.log("\n== 场景 6：srcObject（MSE 直接赋值）也要被判为直播并清除 ==");
{
  const live = new FakeVideo({ src: "", srcObject: { fake: "MediaSource" }, paused: false });
  const h = createHarness({ videos: [live], enabled: false });
  await new Promise((r) => setTimeout(r, 10));
  h.fireStorageChange(true);
  record(live.pauseCalls >= 1, "srcObject 形式的直播媒体没有被暂停");
  record(live.srcObject === null, "srcObject 没有被清空");
}

// ---------------------------------------------------------------- 场景 7
console.log("\n== 场景 7：<source> 子元素形式也要被判为直播并移除 ==");
{
  const child = makeChild("SOURCE");
  const live = new FakeVideo({ src: "", paused: false, children: [child] });
  const h = createHarness({ videos: [live], enabled: false });
  await new Promise((r) => setTimeout(r, 10));
  h.fireStorageChange(true);
  record(live.pauseCalls >= 1, "<source> 形式的直播媒体没有被暂停");
}

// ---------------------------------------------------------------- 场景 8
console.log("\n== 场景 8：关闭屏蔽后，若播放器已被拆掉，应触发刷新以便恢复 ==");
{
  const live = new FakeVideo({ src: LIVE_SRC, paused: false });
  const h = createHarness({ videos: [live], enabled: false });
  await new Promise((r) => setTimeout(r, 10));
  h.fireStorageChange(true);   // 开启 -> 拆掉播放器
  h.flushRaf();
  record(h.reloadCalls.count === 0, "开启屏蔽时不应刷新页面");

  h.fireStorageChange(false);  // 关闭 -> 应安排一次刷新兜底
  record(h.reloadCalls.count === 0, "关闭后不应立刻刷新（先给播放器恢复机会）");
  h.flushTimeouts();
  record(h.reloadCalls.count === 1, "关闭屏蔽且播放器已被拆掉时，应刷新页面以恢复", `reload=${h.reloadCalls.count}`);
}

// ---------------------------------------------------------------- 场景 9
console.log("\n== 场景 9：播放器已自行恢复时，关闭屏蔽不应刷新 ==");
{
  const live = new FakeVideo({ src: LIVE_SRC, paused: false });
  const h = createHarness({ videos: [live], enabled: false });
  await new Promise((r) => setTimeout(r, 10));
  h.fireStorageChange(true);
  h.flushRaf();
  h.fireStorageChange(false);
  // 模拟播放器在等待期内已恢复（有源且在播放）
  live._src = LIVE_SRC;
  live._currentSrc = LIVE_SRC;
  live.paused = false;
  live.readyState = 4;
  h.flushTimeouts();
  record(h.reloadCalls.count === 0, "播放器已恢复时不应刷新页面", `reload=${h.reloadCalls.count}`);
}

// ---------------------------------------------------------------- 场景 10
console.log("\n== 场景 10：播放器本来就没有取源（没有播放链路）时，关闭不应刷新 ==");
{
  // 元素存在但没有源：stopElement 清不出任何东西，不算“拆掉过播放链路”
  const empty = new FakeVideo({ src: "", paused: true });
  const h = createHarness({ videos: [empty], enabled: false });
  await new Promise((r) => setTimeout(r, 10));
  h.fireStorageChange(true);
  h.flushRaf();
  record(h.context.window?.__VLB_MEDIA_STOP__?.tornDown === false, "无源元素不应被记为已拆掉播放链路");
  h.fireStorageChange(false);
  h.flushTimeouts();
  record(h.reloadCalls.count === 0, "未拆过播放链路时不应刷新", `reload=${h.reloadCalls.count}`);
}

console.log("\n================================");
console.log(`检查项: ${checks}  失败: ${failures}`);
console.log(failures === 0 ? "结果: 全部通过" : "结果: 存在失败项");
process.exit(failures === 0 ? 0 : 1);
