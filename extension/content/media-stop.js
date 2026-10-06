/**
 * 立即终止已经在播放的直播媒体（ISOLATED world）。
 *
 * 为什么需要这个文件：
 *   declarativeNetRequest 只能阻止“将来发出”的请求，它既不撤销已发出的请求，
 *   也不拥有页面里的播放对象。直播间已经开播时，<video> 的 src 是
 *     blob:https://live.bilibili.com/<uuid>
 *   这个 blob 由页面里的 MediaSource 供给，数据来自播放器自己的 fetch 循环。
 *   DNR 拦得住那个 fetch，但拦不到 blob: —— 画面会继续从已经追加进 SourceBuffer
 *   的数据里播放，页面侧也没有任何代码去拆除播放器。
 *
 *   所以分工是：
 *     DNR        → 阻止后续视频请求（已有规则，本次不改）
 *     本文件     → 终止已经存在的播放对象
 *
 * 做法（不是隐藏画面）：对直播用的 <video> 元素 pause() 并清空 src + load()，
 * 让媒体元素放弃资源、释放解码器与 MediaSource 缓冲，从而真正停止媒体播放。
 * 因为播放器会自行重建播放链路，所以只要开关是打开的，就持续保持这个状态。
 *
 * 与 DNR 的界限：DNR 负责“阻止未来请求”，本文件负责“终止现有播放”，
 * 两者都不单独构成完整修复，合起来才是。
 */

(() => {
  /** 明确属于直播流的媒体元素才处理，避免误伤直播间的宣传小挂件等其他视频。 */
  function isLiveStreamVideo(el) {
    if (!(el instanceof HTMLVideoElement)) return false;
    if (el.ownerDocument !== document) return false;

    // 直播画面一定经由 MediaSource 供给（blob:），宣传小挂件是直链 mp4。
    // 直播间里可能同时存在两类 video，这个区分是必须的。
    const src = el.currentSrc || el.src || "";
    return src.startsWith("blob:") || Boolean(el.srcObject) || hasSourceChildren(el);
  }

  function hasSourceChildren(el) {
    for (const child of el.children) {
      if (child.tagName === "SOURCE") return true;
    }
    return false;
  }

  /** 终止一个媒体元素：停止播放 + 释放媒体资源。这是“停止”，不是“隐藏”。 */
  function stopElement(el) {
    try {
      if (!el.paused) el.pause();
    } catch {}

    const before = {
      src: String(el.currentSrc || "").slice(0, 120),
      readyState: el.readyState,
      currentTime: Number(el.currentTime?.toFixed?.(2) ?? el.currentTime),
    };

    try {
      // 清空所有取源途径，然后 load() 让元素丢弃当前媒体资源。
      el.removeAttribute("src");
      for (const child of [...el.children]) {
        if (child.tagName === "SOURCE") child.remove();
      }
      el.srcObject = null;
      el.load(); // 释放解码器与 MediaSource 缓冲
    } catch {}

    return before;
  }

  /** 页面里有几个直播媒体元素，就停几个。返回本次实际停掉的数量。 */
  function stopLiveMedia() {
    let stopped = 0;
    let elements = [];
    try {
      elements = [...document.querySelectorAll("video")];
    } catch {
      return 0;
    }
    for (const el of elements) {
      if (!isLiveStreamVideo(el)) continue;
      // 真的拆掉了播放链路才算“终止过播放”：元素本来就没有取源时不算。
      const hadSource = Boolean(el.currentSrc || el.src || el.srcObject);
      const before = stopElement(el);
      lastStop = { at: Date.now(), ...before };
      stopped++;
      if (hadSource) tornDownAny = true;
    }
    if (stopped > 0) stopCount += stopped;
    return stopped;
  }

  // ---------------------------------------------------------------- 状态
  let enabled = false;
  let stopCount = 0;
  let lastStop = null;
  // 本页是否真的拆掉过播放链路。用于判断“关闭屏蔽后需不需要让页面重建播放器”。
  let tornDownAny = false;
  window.__VLB_MEDIA_STOP__ = {
    get stopCount() { return stopCount; },
    get lastStop() { return lastStop; },
    get tornDown() { return tornDownAny; },
  };

  function apply() {
    if (!enabled) return;
    stopLiveMedia();
  }

  // ------------------------------------------------- 播放器是异步创建的，要盯住
  let scheduled = false;
  function scheduleApply() {
    if (!enabled || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  }

  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 播放器可能重建元素或重新设 src，而不是插入新节点；MutationObserver 看不到，
  // 需要一个低频兜底。仅在开关打开时生效。
  setInterval(() => {
    if (enabled) apply();
  }, 500);

  // ---------------------------------------------------------------- 开关同步
  function setEnabled(value) {
    const next = Boolean(value);
    if (next === enabled) {
      if (next) apply();
      return;
    }
    enabled = next;
    if (enabled) {
      // 立即执行一次，不等 MutationObserver。
      apply();
      return;
    }
    // 关闭屏蔽时：如果本页已经把播放器拆掉了，播放器自己不会重建播放链路
    // （实测：关闭后 2 分钟内 video 一直 readyState=0、paused=true、缓冲零增长）。
    // 只有重新加载页面，B站播放器才会干净地重建，因此这里兜底刷新一次。
    if (shouldReloadForRecovery()) {
      reloadForRecovery();
    }
  }

  /**
   * 关闭屏蔽后让页面重建播放器。
   *
   * 先给播放器一次自行恢复的机会，若短时间内仍无播放迹象，再刷新页面兜底。
   */
  let recoveryTimer = null;
  function reloadForRecovery() {
    if (recoveryTimer !== null) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (enabled) return; // 期间用户又打开了屏蔽，则不刷新
      if (!shouldReloadForRecovery()) return; // 已经恢复或已重建，无需刷新
      try {
        location.reload();
      } catch {}
    }, 1500);
  }

  /** 页面上是否已经有正在播放的直播媒体。 */
  function anyLiveMediaPlaying() {
    try {
      for (const el of document.querySelectorAll("video")) {
        if (!isLiveStreamVideo(el)) continue;
        if (!el.paused && el.readyState >= 3) return true;
      }
    } catch {}
    return false;
  }

  /**
   * 关闭屏蔽后是否需要用刷新来恢复。
   *
   * 判据必须同时满足：
   *   1. 本页确实终止过播放（否则不该刷新）
   *   2. 现在没有直播媒体在播放（说明播放器没有自行恢复）
   * 这样对“播放器仍在正常播放”或“从未拆过播放器”的页面都不会刷新。
   */
  function shouldReloadForRecovery() {
    return tornDownAny && !anyLiveMediaPlaying();
  }

  // 项目既有的跨上下文机制就是 storage（overlay.js 已在用），不新建通信框架。
  void chrome.storage.local
    .get({ enabled: false })
    .then(({ enabled: value }) => setEnabled(value))
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.enabled) return;
    setEnabled(changes.enabled.newValue);
  });

  // 从 bfcache 恢复时，页面状态被冻结过，重新应用一次。
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) apply();
  });
})();
