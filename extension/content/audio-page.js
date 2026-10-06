/**
 * V2 纯音频播放器 —— 主世界部分（MAIN world）。
 *
 * 为什么必须跑在主世界：
 *   实测（Edge 154 / mpegts.js 1.7.3）在内容脚本的隔离世界里，给页面里的媒体元素
 *   设置 MediaSource 的 blob URL 不会触发 sourceopen：src 读回来是正确的
 *   blob:https://live.bilibili.com/...，但 readyState 永远是 0，播放器既不报错也不发请求。
 *   同样代码放在主世界则一切正常（readyState 4 / decodedVideo 0）。
 *   所以这一层只负责“拿到 URL 就播”，是纯粹的 mpegts 包装。
 *
 * 另一个实测坑（排查用得上，代码里不需要处理）：
 *   标签页被切到后台时，MediaSource 的 sourceopen 同样不会触发，
 *   表现为完全一样（不报错、无请求、readyState 0）。
 *   自动化验收必须让直播间标签页保持激活，否则会误判成播放器坏了。
 *
 * 这一层刻意不含任何 B站知识：URL 由隔离世界（content/audio-player.js）从
 * service worker 拿到后通过 postMessage 递进来。B站相关的判断全部集中在
 * shared/bilibili-signatures.js，改版时只改那一处。
 *
 * 通信协议：
 *   host → page : { source:"vlb-audio-host", cmd:"play", url, volume } | { cmd:"stop" } | { cmd:"resume" }
 *   page → host : { source:"vlb-audio-page", evt:"ready"|"playing"|"error"|"ended"|"media-info", detail }
 *
 * 自动播放策略（实测 2026-10-06，Edge 默认策略、未传 --autoplay-policy）：
 *   没有用户手势时 play() 被拒（NotAllowedError）。用户点过 bilibili 的直播间
 *   （origin 已有激活）时正常；直接输入 URL、全新 profile 时会被拦一次。
 *
 *   **实测结论：这个策略对 <audio> 连静音播放也一并拦下**（muted=true 后 play() 仍返回
 *   NotAllowedError；连新建的普通 <audio muted src=dataURI> 也一样），所以“静音兜底”不可行，
 *   不能靠它把链路跑起来 —— 那样只会留下一个 muted 的假播放状态。
 *   唯一可行的恢复方式是：页面出现用户手势后，对**同一个实例**再调一次 play()（见 resume()）。
 *   全程不重新取流、不重建 <audio>、不重新初始化播放器。
 */

(() => {
  "use strict";

  if (self.__VLB_AUDIO_PAGE__) return; // 重复注入保护
  self.__VLB_AUDIO_PAGE__ = true;

  const TAG = "[vlb-audio-page]";
  const mpegts = self.mpegts ?? null;
  const HOST_SOURCE = "vlb-audio-host";
  const PAGE_SOURCE = "vlb-audio-page";

  let el = null;
  let player = null;

  /** mpegts 的 ERROR 事件给的是数字枚举 + 自定义错误对象，直接拼字符串会得到 [object Object]。 */
  const ERROR_TYPES = { 1: "NETWORK_ERROR", 2: "MEDIA_ERROR", 3: "OTHER_ERROR" };

  function describeError(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      const picked = {};
      for (const key of ["code", "msg", "message", "reason", "name", "info"]) {
        if (value[key] != null) picked[key] = value[key];
      }
      const text = JSON.stringify(picked);
      if (text && text !== "{}") return text;
    } catch {}
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  function emit(evt, detail) {
    try {
      window.postMessage({ source: PAGE_SOURCE, evt, detail }, location.origin);
    } catch {}
  }

  function teardown() {
    if (player) {
      try { player.pause(); } catch {}
      try { player.unload(); } catch {}
      try { player.detachMediaElement(); } catch {}
      try { player.destroy(); } catch {}
      player = null;
    }
    if (el) {
      try { el.pause(); el.removeAttribute("src"); el.load(); } catch {}
      try { el.remove(); } catch {}
      el = null;
    }
  }

  function play(url, volume) {
    teardown();

    if (!mpegts) {
      emit("error", { kind: "no-mpegts", message: "mpegts.js 未加载" });
      return;
    }
    if (!url) {
      emit("error", { kind: "no-url", message: "没有可播放的地址" });
      return;
    }

    el = document.createElement("audio");
    // <audio> 而不是 <video>：media-stop.js 只挑 HTMLVideoElement，
    // 这样 V2 播放器天然不在 V1“终止已有播放”的范围内，不需要互相加特例。
    el.setAttribute("data-vlb-audio", "1");
    el.autoplay = true;
    // 音量由隔离世界从 chrome.storage 读出后随 play 指令带进来（主世界拿不到扩展 API）。
    // 缺省 1，与滑块默认值一致。
    el.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    el.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    (document.body || document.documentElement).appendChild(el);

    try {
      player = mpegts.createPlayer(
        { type: "flv", isLive: true, url },
        {
          // 不开 worker：worker 里的请求在 DevTools / CDP 里看不到，验收时无法核对流量。
          enableWorker: false,
          liveBufferLatencyChasing: true,
          lazyLoad: false,
        },
      );
    } catch (error) {
      console.error(TAG, "createPlayer 失败", error);
      teardown();
      emit("error", { kind: "create-player", message: String(error?.message ?? error) });
      return;
    }

    const instance = player;

    instance.on(mpegts.Events.ERROR, (type, detail, info) => {
      if (instance !== player) return;
      const text = `${ERROR_TYPES[type] ?? type} / ${describeError(detail)}${info ? ` / ${describeError(info)}` : ""}`;
      console.error(TAG, "mpegts ERROR", text);
      emit("error", { kind: "mpegts", detail: text });
    });
    instance.on(mpegts.Events.LOADING_COMPLETE, () => {
      if (instance !== player) return;
      emit("ended", {});
    });
    instance.on(mpegts.Events.MEDIA_INFO, (info) => {
      if (instance !== player) return;
      emit("media-info", info ?? {});
    });

    el.addEventListener("error", () => {
      if (instance !== player) return;
      emit("error", { kind: "element", detail: String(el?.error?.code ?? "") });
    });

    instance.attachMediaElement(el);
    instance.load();

    // 未静音的自动播放会被浏览器策略拦下（首次访问、无页面手势时，见文件头说明）。
    // 被拒时**不拆链路**：保留同一个 <audio> / MediaSource / mpegts 实例，
    // 等页面出现用户手势后由 resume() 再调一次 play()。
    instance
      .play()
      .then(() => {
        if (instance !== player) return;
        emit("playing", {});
      })
      .catch((error) => {
        if (instance !== player) return;
        emit("error", { kind: "autoplay", detail: String(error?.name ?? error) });
      });

    emit("ready", {});
  }

  /**
   * 用户手势之后恢复播放。
   *
   * 只对**现有实例**再调一次 play()：不重新取流、不重建 <audio>、不重新初始化播放器。
   * 由隔离世界在页面第一个用户手势时调用（见 content/audio-player.js）。
   */
  function resume() {
    if (!el || !player) return;
    if (!el.paused) {
      emit("playing", {});
      return;
    }
    const instance = player;
    let pending;
    try {
      pending = instance.play();
    } catch (error) {
      emit("error", { kind: "autoplay", detail: String(error?.name ?? error) });
      return;
    }
    Promise.resolve(pending).then(
      () => {
        if (instance !== player) return;
        // play() 已 resolve 但元素仍是暂停态（极少见）：交给宿主继续等下一次手势。
        if (el && !el.paused) emit("playing", {});
        else emit("error", { kind: "autoplay", detail: "resume 后仍未播放" });
      },
      (error) => {
        if (instance !== player) return;
        emit("error", { kind: "autoplay", detail: String(error?.name ?? error) });
      },
    );
  }

  // ---------------------------------------------------------------- 消息入口
  // 房间号只由隔离世界按 URL 判断（/12345 与 /blanc/12345）。
  // B站直播首页大屏（live.bilibili.com/）不在插件支持范围内，这里不再读
  // window.playerInstance.opts.cid，也不再有 page-room 上报。
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOST_SOURCE) return;
    if (data.cmd === "play") play(data.url, data.volume);
    else if (data.cmd === "stop") teardown();
    else if (data.cmd === "resume") resume();
  });

  console.info(TAG, "已就绪", mpegts ? "" : "（mpegts.js 缺失）");
})();
