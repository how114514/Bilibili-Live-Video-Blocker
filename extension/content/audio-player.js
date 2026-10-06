/**
 * V2 纯音频播放器 —— 控制层（ISOLATED world）。
 *
 * 职责：开关状态、房间识别、向 service worker 取纯音频地址、重试/重连/URL 刷新、
 * 把状态写进 storage 供 popup 显示。
 *
 * 实际播放（mpegts.js + MediaSource）在 MAIN world 的 content/audio-page.js 里，
 * 原因是实测隔离世界给页面媒体元素挂 MediaSource 不会触发 sourceopen：
 * src 是对的 blob URL，但 readyState 永远 0，既不报错也不发请求。详见 audio-page.js。
 * 这一层通过 postMessage 把地址递过去，并读回播放事件。
 *
 * 与 V1 的分工不变：
 *   V1 DNR            → 阻止 B站播放器的复用流请求
 *   V1 media-stop.js  → 终止已经在播放的 B站视频元素
 *   本文件 + audio-page.js → 只负责“取纯音频流并播放”
 */

(() => {
  "use strict";

  const TAG = "[vlb-audio]";
  const STATUS_KEY = "audioStatus";
  const HOST_SOURCE = "vlb-audio-host";
  const PAGE_SOURCE = "vlb-audio-page";
  const ELEMENT_SELECTOR = 'audio[data-vlb-audio="1"]';
  /** 插件自己的页面 UI（content/overlay.js 的圆形按钮与提示）带这个属性。 */
  const OWN_UI_SELECTOR = "[data-vlb-ui]";

  /** 全部可调参数集中在这里。 */
  const TUNING = {
    watchdogIntervalMs: 5000,
    /** currentTime 多久不前进就判定为卡死。 */
    stallMs: 20000,
    /** 向 service worker 取地址的超时。MV3 的 SW 会休眠，消息通道偶尔既不回也不报错。 */
    resolveTimeoutMs: 12000,
    /** URL 过期前多久换新的备用地址（秒）。实测有效期约 1 小时。 */
    refreshLeadSec: 300,
    retryBaseMs: 1500,
    retryMaxMs: 30000,
    maxFastRetries: 6,
    /** 快速重试用尽后的慢速兜底间隔，避免死循环猛打接口。 */
    slowRetryMs: 60000,
  };

  // ------------------------------------------------------------------ 状态

  let enabled = false;
  let roomId = null;
  /** 插件自己的音量（0~1），来源与唯一事实仍是 chrome.storage.local.volume。 */
  let volume = 1;
  let stream = null; // { url, urls, expiresAt, session }
  /** 当前用的是 stream.urls 里的第几个候选主机。 */
  let urlIndex = 0;
  let refreshTimer = null;
  let retryTimer = null;
  let watchdogTimer = null;
  let fastRetries = 0;
  let lastProgress = { at: 0, t: -1 };
  let phase = "idle";
  let detail = "";
  let gestureArmed = false;
  /** 取到的流含视频轨的房间号：在换房间或重新开开关之前不再重试。 */
  let unusableRoom = null;
  /** 每次 start/teardown 自增，用来丢弃上一轮异步流程与旧事件的回调。 */
  let generation = 0;

  const log = (...args) => console.info(TAG, ...args);
  const pageEl = () => document.querySelector(ELEMENT_SELECTOR);

  // -------------------------------------------------------------- 状态上报

  function safeHost(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  function report(nextPhase, nextDetail) {
    phase = nextPhase;
    detail = nextDetail ?? "";
    const el = pageEl();
    try {
      void chrome.storage.local.set({
        [STATUS_KEY]: {
          at: Date.now(),
          phase,
          detail,
          roomId,
          playing: Boolean(el && !el.paused && el.readyState >= 2),
          currentTime: el ? Number(el.currentTime.toFixed(1)) : null,
          retries: fastRetries,
          // 只上报主机名，不上报带签名的完整 URL
          host: stream?.url ? safeHost(stream.url) : null,
          expiresAt: stream?.expiresAt ?? null,
        },
      });
    } catch {}
  }

  // ------------------------------------------------------------ 房间号识别

  /**
   * 当前应该播放的房间号：路径首段是数字，或 /blanc/<数字>。
   * 与 V1 live-state.js 的判据一致。
   *
   * 唯一来源就是 URL。B站直播首页大屏（pathname 恒为 "/"）不在插件支持范围内，
   * 因此不再读页面播放器实例，也不再接受页面自报的房间号。
   */
  function currentRoomId() {
    const match = /^\/(?:blanc\/)?(\d+)(?:\/|$)/.exec(location.pathname);
    return match ? match[1] : null;
  }

  // ------------------------------------------------------------ 主世界通信

  function postToPage(cmd, url, withVolume = false) {
    try {
      // 主世界拿不到 chrome.storage，音量必须随指令带过去，元素创建时就按这个值设置。
      window.postMessage(
        { source: HOST_SOURCE, cmd, url, volume: withVolume ? volume : undefined },
        location.origin,
      );
    } catch (error) {
      log("postMessage 失败", error);
    }
  }

  function onPageEvent(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE) return;

    switch (data.evt) {
      case "playing":
        // 刻意不在这里清零 fastRetries。
        // 一次“短暂播通又断”的抖动如果重置计数，重试就成了死循环：
        // 每次都能播上几十秒、计数归零、再断、再重试，永远退不出去。
        // 计数只在真正换了房间 / 重新开关时（start 的 isRetry=false 路径）清零。
        disarmGesture(); // 已经在播放：不再需要手势，注销监听
        lastProgress = { at: Date.now(), t: -1 };
        report("playing", "正在播放纯音频");
        break;

      case "media-info": {
        // 取流接口的字段不可信，但真正解出来的轨道是可信任的：
        // 一旦出现视频轨，说明拿到的不是纯音频流，必须停掉而不是继续放。
        const hasVideo = Boolean(data.detail?.videoCodec);
        if (hasVideo) {
          console.error(TAG, "拿到的是音视频复用流，已停止播放", data.detail);
          // 标记这个房间不可用：否则 teardown 清空 roomId 之后，下一秒的轮询
          // 会认为“房间变了”而立刻重启，变成没完没了地打取流接口。
          // 要恢复只能换房间或重新开关。
          unusableRoom = roomId;
          teardown("取到的流含视频轨，已停止（B站接口可能已变更）");
          report("failed", "取到的流含视频轨，已停止（B站接口可能已变更）");
        } else {
          log("媒体信息（纯音频）", data.detail);
        }
        break;
      }

      case "error": {
        const kind = data.detail?.kind;
        if (kind === "autoplay") {
          // 自动播放被浏览器策略拦下（或手势后恢复没成功）：这不是流的问题，
          // 不计入重连次数，也不重新取流 —— 只继续等下一次页面手势。
          armGestureRetry();
        } else {
          console.error(TAG, "播放错误", data.detail);
          scheduleReconnect(`播放错误：${data.detail?.kind ?? "未知"} ${data.detail?.detail ?? ""}`.trim());
        }
        break;
      }

      case "ended":
        scheduleReconnect("直播流连接结束");
        break;

      default:
        break;
    }
  }

  window.addEventListener("message", onPageEvent);

  // ------------------------------------------------------------ 开关与轮询

  /**
   * 自动播放被浏览器策略拦下（首次访问、无页面手势时，见 audio-page.js 文件头）。
   * 实测该策略对 <audio> 连静音播放也一并拦下，所以没有“先静音跑起来”的兜底，
   * 只能等页面上的第一个用户手势，然后对同一个播放实例再调一次 play()。
   * 不重新取流、不重建播放器。
   */
  function armGestureRetry() {
    report("blocked", "等待页面交互以播放声音");
    if (gestureArmed) return;
    gestureArmed = true;
    document.addEventListener("pointerdown", onUnlockGesture, true);
    document.addEventListener("keydown", onUnlockGesture, true);
  }

  function onUnlockGesture(event) {
    // 插件自己的按钮（圆形开关）不是“页面手势”：点它只应该开关插件，
    // 否则一次点击会同时触发开关和恢复播放，状态会乱。
    if (event.target instanceof Element && event.target.closest(OWN_UI_SELECTOR)) return;
    if (!enabled) return;
    postToPage("resume");
    // 刻意不在这里注销：等主世界回报真正在播放（playing）后再注销，
    // 否则 audio 恰好被重建时这一次手势就白费了。
  }

  function disarmGesture() {
    if (!gestureArmed) return;
    gestureArmed = false;
    document.removeEventListener("pointerdown", onUnlockGesture, true);
    document.removeEventListener("keydown", onUnlockGesture, true);
  }

  // ------------------------------------------------------------ 健康检查

  function startWatchdog() {
    if (watchdogTimer !== null) return;
    watchdogTimer = setInterval(() => {
      if (!enabled || !roomId) return;
      const el = pageEl();
      if (!el) return;

      const now = Date.now();
      const current = Number(el.currentTime);

      // 暂停时 currentTime 本来就不动：自动播放被拦、或用户自己暂停，
      // 都不该被当成“流卡死”去重连。
      if (el.paused) {
        lastProgress = { at: now, t: current };
        return;
      }

      if (current !== lastProgress.t) {
        lastProgress = { at: now, t: current };
        return;
      }
      if (now - lastProgress.at < TUNING.stallMs) return;
      scheduleReconnect(`音频 ${Math.round((now - lastProgress.at) / 1000)} 秒没有前进`);
    }, TUNING.watchdogIntervalMs);
  }

  function stopWatchdog() {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // ------------------------------------------------------------ 重连 / 重试

  function scheduleReconnect(reason) {
    if (!enabled || !roomId) return;
    const gen = generation;
    teardownInternal();
    stopWatchdog();

    urlIndex += 1; // 下次尝试换一个候选主机
    fastRetries += 1;
    const exhausted = fastRetries > TUNING.maxFastRetries;
    const delay = exhausted
      ? TUNING.slowRetryMs
      : Math.min(TUNING.retryBaseMs * 2 ** (fastRetries - 1), TUNING.retryMaxMs);

    report(
      exhausted ? "failed" : "retrying",
      exhausted
        ? `${reason}；已重试 ${TUNING.maxFastRetries} 次仍失败，改为每 ${Math.round(TUNING.slowRetryMs / 1000)} 秒重试一次`
        : `${reason}；${(delay / 1000).toFixed(1)} 秒后第 ${fastRetries} 次重试`,
    );

    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (gen !== generation || !enabled || !roomId) return;
      void start(roomId, { isRetry: true });
    }, delay);
  }

  // ------------------------------------------------------------ URL 过期

  /**
   * 直播 FLV 是一条长连接，URL 过期本身不会打断正在进行的播放；
   * 但一旦断线需要重连，就必须用没过期的 URL。所以提前换一条备用，不重启播放。
   */
  function scheduleRefresh() {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    const expiresAt = stream?.expiresAt;
    const fallbackMs = 50 * 60 * 1000; // 拿不到 expires 时的保守兜底
    const dueMs = expiresAt
      ? Math.max(30_000, (expiresAt - TUNING.refreshLeadSec) * 1000 - Date.now())
      : fallbackMs;
    const gen = generation;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (gen !== generation || !enabled || !roomId) return;
      void refreshStream();
    }, Math.min(dueMs, fallbackMs));
  }

  async function refreshStream() {
    if (!enabled || !roomId) return;
    try {
      const next = await resolveStream(roomId);
      stream = next; // 只换备用地址，不动正在播的连接
      urlIndex = 0; // 候选主机整批换新，重试计数归零
      log("已刷新备用地址 host =", safeHost(next.url));
      scheduleRefresh();
    } catch (error) {
      log("刷新地址失败，稍后重试：", String(error?.message ?? error));
      const gen = generation;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (gen !== generation || !enabled || !roomId) return;
        void refreshStream();
      }, 60_000);
    }
  }

  // ---------------------------------------------------------------- 取流

  /**
   * MV3 的 service worker 随时可能休眠，消息通道偶尔既不回也不报错。
   * 没有这个超时，一次挂起就会让整条播放链路永久停在“取流中”。
   */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000} 秒）`)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async function resolveStream(room) {
    const res = await withTimeout(
      chrome.runtime.sendMessage({ type: "resolveAudioStream", roomId: room }),
      TUNING.resolveTimeoutMs,
      "取流",
    );
    if (!res?.ok) throw new Error(res?.error ?? "取流失败");
    const urls = Array.isArray(res.urls) && res.urls.length ? res.urls : [res.url];
    return { url: urls[0], urls, expiresAt: res.expiresAt ?? null, session: res.session ?? null };
  }

  // ------------------------------------------------------------ 生命周期

  /** 只拆播放链路，不动 enabled / roomId。 */
  function teardownInternal() {
    disarmGesture();
    postToPage("stop");
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  /**
   * 彻底停止一整个会话：拆链路、清定时器、清房间。
   * 不改变 enabled —— 用于“离开直播间”“切换直播间”，
   * 这里如果把 enabled 一起置 false，用户回到直播间后就再也不会自动恢复。
   */
  function teardown(reason) {
    generation += 1;
    teardownInternal();
    stopWatchdog();
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    fastRetries = 0;
    stream = null;
    roomId = null;
    report("idle", reason);
  }

  /** 关闭开关：拆掉播放链路，并停止后续自动重启。 */
  function stop(reason = "已关闭") {
    enabled = false;
    teardown(reason);
  }

  async function start(room, options = {}) {
    if (!enabled) return;
    roomId = room;
    generation += 1;
    const gen = generation;

    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    teardownInternal();
    stopWatchdog();
    if (!options.isRetry) {
      fastRetries = 0;
      urlIndex = 0;
    }

    let next;
    // 重试时先在**同一批候选主机**里换一个：实测部分省级 CDN 节点会对 FLV 直接 403，
    // 同一个响应里的其它节点往往可用。把这一批用尽之后，才重新请求接口换一批。
    if (options.isRetry && Array.isArray(stream?.urls) && urlIndex < stream.urls.length) {
      next = { ...stream, url: stream.urls[urlIndex] };
      log(`换用同批候选主机 ${urlIndex + 1}/${stream.urls.length}：`, safeHost(next.url));
    } else {
      report("resolving", "正在获取纯音频流地址");
      try {
        next = await resolveStream(room);
      } catch (error) {
        if (gen !== generation) return;
        console.error(TAG, "取流失败", error);
        scheduleReconnect(`取流失败：${error?.message ?? error}`);
        return;
      }
      if (gen !== generation || !enabled || roomId !== room) return; // 期间切了房间/关了开关
      urlIndex = 0;
    }

    stream = next;
    lastProgress = { at: Date.now(), t: -1 };
    report("resolving", "正在连接纯音频流");
    postToPage("play", next.url, true);
    startWatchdog();
    scheduleRefresh();
    log("开始播放", safeHost(next.url), `候选主机 ${next.urls?.length ?? 1} 个`);
  }

  /** 房间切换：先彻底拆掉旧房间，再起新房间，避免两个音频同时响。 */
  async function switchRoom(nextRoomId) {
    if (!enabled) return;
    if (nextRoomId === roomId) return;
    if (nextRoomId !== unusableRoom) unusableRoom = null; // 换到别的房间就重新给机会
    log("切换房间", roomId, "->", nextRoomId);
    teardown("切换直播间");
    await start(nextRoomId);
  }

  function reload() {
    if (!enabled) return;
    const room = currentRoomId();
    if (!room) {
      report("idle", "当前不是直播间页面");
      return;
    }
    void start(room);
  }

  async function setEnabled(value) {
    const next = Boolean(value);
    if (next === enabled && next) return;
    enabled = next;
    if (!next) {
      stop("已关闭视频屏蔽");
      return;
    }
    unusableRoom = null; // 手动重新打开 = 再给一次机会
    const room = currentRoomId();
    if (!room) {
      report("idle", "当前不是直播间页面");
      return;
    }
    await start(room);
  }

  /**
   * 房间切换在 B站直播是 SPA 内跳转，没有页面加载事件，只能低频轮询。
   * 同时兼顾“从非直播间页面导航进直播间”（URL 会变，靠这一轮轮询跟上）。
   */
  function poll() {
    if (!enabled) return;
    const current = currentRoomId();
    if (!current) {
      if (roomId) teardown("已离开直播间");
      return;
    }
    if (current === unusableRoom) return; // 已判定该房间取不到纯音频流，等换房间
    if (current !== roomId) void switchRoom(current);
  }

  // ---------------------------------------------------------------- 启动

  /** 音量只在这里归一化，其余地方直接用。 */
  function normalizeVolume(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  }

  void chrome.storage.local
    .get({ enabled: false, volume: 1 })
    .then(({ enabled: value, volume: stored }) => {
      volume = normalizeVolume(stored);
      return setEnabled(value);
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.volume) {
      volume = normalizeVolume(changes.volume.newValue);
      // 拖滑块时元素已经由 overlay.js 直接改过音量，这里只是让内存值跟上，
      // 供下一次取流 / 重建播放器时使用。
      return;
    }
    if (!changes.enabled) return;
    void setEnabled(changes.enabled.newValue);
  });

  // 从 bfcache 恢复时页面被冻结过，重新起一次。
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && enabled) reload();
  });

  // 供最终验收脚本读取内部状态（只读，不改变行为）。
  self.__VLB_AUDIO__ = {
    get phase() { return phase; },
    get detail() { return detail; },
    get roomId() { return roomId; },
    get retries() { return fastRetries; },
  };

  setInterval(poll, 1000);
  log("V2 控制层已就绪");
})();
