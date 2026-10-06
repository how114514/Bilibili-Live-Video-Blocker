/**
 * 直播间状态采集（ISOLATED world）。
 *
 * 把当前直播间的可观测事实写进 storage，供 popup 显示：
 * 是否在直播间、直播是否进行中、页面里是否还有 vid 元素。
 *
 * 只读取，不修改 B站页面，也不承担任何拦截职责。
 */

(() => {
  const LIVE_SNAPSHOT_KEY = "liveSnapshot";

  /**
   * 自动化测试入口：URL 上带 ?vlb=on|off 与 ?vlbblock=manifest|segments|all 时
   * 直接设定开关与阻止策略，免去点击 popup。仅用于测试，正常使用不受影响。
   */
  const params = new URLSearchParams(location.search);
  const requested = params.get("vlb");
  if (requested === "on" || requested === "off") {
    const enabled = requested === "on";
    const blockMode = params.get("vlbblock") || undefined;
    void chrome.storage.local
      .set({ enabled })
      .then(() => chrome.runtime.sendMessage({ type: "setEnabled", enabled, blockMode }));
  }

  function isLiveRoomPage() {
    // 只认具体直播间（/12345 与 /blanc/12345）。
    // 直播首页大屏（/）不在插件支持范围内，不产生纯音频，因此不算“在直播播放页”。
    return location.hostname === "live.bilibili.com" && /^\/\d+|^\/blanc\//.test(location.pathname);
  }

  function readSnapshot() {
    const video = document.querySelector("video");
    const danmakuContainer =
      document.querySelector("#danmukuBox, .danmaku-item-container, .danmaku-screen, .bpx-player-row-dm-wrap") ??
      document.querySelector('[class*="danmaku"]');

    // 直播媒体是否已经被 media-stop.js 终止（用于区分“已停止播放”与“仅拦到请求”）。
    const mediaStop = window.__VLB_MEDIA_STOP__;
    const liveVideo = findLiveVideo();

    return {
      at: Date.now(),
      href: location.href,
      isLiveRoomPage: isLiveRoomPage(),
      liveStatusText:
        (document.querySelector(".live-status-tag, .live-status, [class*='live-status']")?.textContent ?? "")
          .trim()
          .slice(0, 24) || null,
      videoPresent: Boolean(video),
      videoReadyState: video?.readyState ?? null,
      videoWidth: video?.videoWidth ?? null,
      videoErrorCode: video?.error?.code ?? null,
      danmakuPresent: Boolean(danmakuContainer),
      // 新增：已停止播放的直播媒体元素数量与累计次数
      liveVideoStopped: liveVideo ? !liveVideo.isPlaying : null,
      liveVideoPaused: liveVideo ? liveVideo.paused : null,
      liveVideoSrcCleared: liveVideo ? liveVideo.srcCleared : null,
      mediaStopCount: mediaStop?.stopCount ?? 0,
    };
  }

  /** 找出直播用的媒体元素（blob: 源），宣传小挂件是直链 mp4，不算。 */
  function findLiveVideo() {
    for (const el of document.querySelectorAll("video")) {
      const src = el.currentSrc || el.src || "";
      const fromMediaSource = src.startsWith("blob:") || Boolean(el.srcObject);
      if (!fromMediaSource && !el.querySelector("source")) continue;
      return {
        paused: el.paused,
        isPlaying: !el.paused && el.readyState > 2,
        srcCleared: !src,
      };
    }
    return null;
  }

  const write = () => {
    try {
      void chrome.storage.local.set({ [LIVE_SNAPSHOT_KEY]: readSnapshot() });
    } catch {}
  };

  write();
  // 直播状态（开播/下播、切换直播间）会变化，低频轮询即可。
  setInterval(write, 5000);
})();
