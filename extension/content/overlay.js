/**
 * 页面内控制入口（ISOLATED world，纯 UI）。
 *
 * 这里只做三件事：
 *   1. 显示插件开关状态：一个 28×28 的圆形按钮。
 *   2. 提供开关入口。按钮点击**只写 chrome.storage.local.enabled**，
 *      与 popup 完全同一条链路：storage → service worker → DNR / audio-player。
 *      按钮不碰 DNR、不碰播放器、不维护第二套状态。
 *   3. 插件自己的音量滑块。它只改插件 <audio>.volume 并写 storage.volume，
 *      不碰 B站原生播放器，不触发开关，也不重新取流。
 *
 * **只在具体直播间显示**（/12345 与 /blanc/12345）。直播首页大屏不在插件支持范围内，
 * 那里不产生插件音频，也就不显示任何插件 UI。
 *
 * 为什么要 position:fixed + document.body：
 *   播放器容器会被 B站重建，房间页的播放器还可能嵌在 /blanc/ iframe 里（容器在主框架），
 *   挂在容器内部会被裁剪，也会受祖先 stacking context 影响。挂在 body 上、坐标由播放器容器的
 *   getBoundingClientRect() 现算，普通直播间与 blanc 布局表现一致，且天然只有一个实例。
 *
 * 按钮、提示、滑块都带 data-vlb-ui：audio-player.js 的手势解锁监听会忽略它们，
 * 否则操作插件 UI 会被误当成“页面手势”，或反过来被当成点击播放器。
 */

(() => {
  "use strict";

  const BADGE_ID = "vlb-badge";
  const SLIDER_ID = "vlb-volume";
  const TOAST_ID = "vlb-toast";
  const AUDIO_STATUS_KEY = "audioStatus";
  const VOLUME_KEY = "volume";
  const ELEMENT_SELECTOR = 'audio[data-vlb-audio="1"]';
  const OWN_UI_ATTR = "data-vlb-ui";
  /** 阶段名来自 content/audio-player.js 的 report()，两边必须一致。 */
  const PHASE_LABEL = {
    idle: "未播放",
    resolving: "获取音频…",
    playing: "音频播放中",
    retrying: "重连中",
    failed: "音频不可用",
    blocked: "点击页面任意处开启声音",
  };
  /** 提示显示时长；重复点击重新计时。 */
  const TOAST_MS = 2500;
  /** 按钮相对播放器容器左上角的偏移：避开 B站顶部信息挂件与底部控制条。 */
  const OFFSET = { x: 10, y: 34 };
  const BUTTON_SIZE = 28;
  /** 音量滑块（在按钮右侧，同一行）。 */
  const SLIDER_SIZE = { w: 76, h: 20 };
  const SLIDER_GAP = 6;

  let enabled = false;
  let phase = null;
  let volume = 1; // 0~1，唯一事实来源是 chrome.storage.local.volume
  let button = null;
  let slider = null;
  let toast = null;
  let toastTimer = null;
  let toggling = false;
  let draggingVolume = false;
  let repositionScheduled = false;

  const CSS = `
    #${BADGE_ID} {
      position: fixed; z-index: 2147483000;
      width: ${BUTTON_SIZE}px; height: ${BUTTON_SIZE}px; border-radius: 50%;
      box-sizing: border-box; border: 1px solid rgba(255, 255, 255, .28);
      display: flex; align-items: center; justify-content: center;
      font: 15px/1 "Segoe UI Emoji", "Apple Color Emoji", -apple-system, "Segoe UI", sans-serif;
      color: #fff; background: rgba(12, 14, 18, .62); cursor: pointer;
      user-select: none; -webkit-user-select: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .35);
      transition: background-color .15s ease, opacity .15s ease, transform .1s ease;
    }
    #${BADGE_ID}:hover { transform: scale(1.08); }
    #${BADGE_ID}.is-off { opacity: .55; background: rgba(12, 14, 18, .55); }
    #${BADGE_ID}.is-on  { background: rgba(35, 165, 90, .88); border-color: rgba(255, 255, 255, .45); }
    #${BADGE_ID}.is-warn { background: rgba(196, 132, 26, .9); border-color: rgba(255, 255, 255, .45); }
    #${BADGE_ID}.is-bad { background: rgba(190, 48, 52, .9); border-color: rgba(255, 255, 255, .45); }
    #${BADGE_ID}[hidden] { display: none; }
    #${SLIDER_ID} {
      position: fixed; z-index: 2147483000;
      width: ${SLIDER_SIZE.w}px; height: ${SLIDER_SIZE.h}px;
      box-sizing: border-box; margin: 0; padding: 0 6px;
      display: flex; align-items: center;
      border-radius: 999px; border: 1px solid rgba(255, 255, 255, .28);
      background: rgba(12, 14, 18, .62); cursor: pointer;
      accent-color: #23a55a;
      -webkit-appearance: none; appearance: none;
    }
    /* 自绘轨道/滑块：Chrome 的 accent-color 对 range 的默认样式在深色底上不够清楚 */
    #${SLIDER_ID}::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .35);
    }
    #${SLIDER_ID}::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 12px; height: 12px; margin-top: -4px; border-radius: 50%;
      background: #fff; border: none; box-shadow: 0 1px 3px rgba(0, 0, 0, .4);
    }
    #${SLIDER_ID}[hidden] { display: none; }
    #${TOAST_ID} {
      position: fixed; z-index: 2147483000; pointer-events: none;
      padding: 5px 10px; border-radius: 6px;
      background: rgba(12, 14, 18, .82); color: #fff;
      font: 12px/1.3 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      white-space: nowrap; opacity: 0; transition: opacity .18s ease;
    }
    #${TOAST_ID}.is-visible { opacity: 1; }
    #${TOAST_ID}[hidden] { display: none; }
  `;

  /** 只在具体直播间显示插件 UI；首页大屏不在支持范围内。 */
  function isRoomPage() {
    return /^\/(?:blanc\/)?\d+(?:\/|$)/.test(location.pathname);
  }

  /** 插件自己的 <audio> 是否已经存在（由 audio-player.js 创建在主世界，DOM 是共享的）。 */
  function hasPluginAudio() {
    return Boolean(document.querySelector(ELEMENT_SELECTOR));
  }

  /**
   * 定位容器候选，按“越靠内越准确”排序。
   * 实测两种直播间布局：
   *   主框架播放器：#player-ctnr > #live-player
   *   blanc iframe：#player-ctnr 包住 iframe，容器仍在主框架
   */
  function findPlayerBox() {
    const box =
      document.querySelector("#live-player") ||
      document.querySelector("#player-ctnr") ||
      document.querySelector(".player-ctnr") ||
      document.querySelector(".live-player") ||
      document.querySelector("video")?.parentElement ||
      null;
    if (!box) return null;
    const rect = box.getBoundingClientRect();
    // 容器还没布局（宽高为 0）时按“不存在”处理，按钮隐藏。
    if (rect.width < 80 || rect.height < 60) return null;
    return rect;
  }

  /**
   * 按钮图标：音量 0 时显示 🔇。
   * 这只是同一开关下的视觉反馈，**静音不等于关闭插件** —— 状态类名仍然区分
   * is-off（插件关闭，灰色）与 is-on/is-warn（插件开启，绿色/琥珀色）。
   */
  function statusInfo() {
    if (!enabled) return { cls: "is-off", icon: "🔇", text: "省流量模式已关闭" };
    const icon = volume > 0 ? "🔊" : "🔇";
    const mutedNote = volume > 0 ? "" : " · 音量为 0";
    if (phase === "playing") return { cls: "is-on", icon, text: `省流量模式已开启 · 音频播放中${mutedNote}` };
    if (!phase || !PHASE_LABEL[phase]) return { cls: "is-on", icon, text: `省流量模式已开启${mutedNote}` };
    if (phase === "failed") return { cls: "is-bad", icon, text: `省流量模式已开启 · ${PHASE_LABEL[phase]}` };
    return { cls: "is-warn", icon, text: `省流量模式已开启 · ${PHASE_LABEL[phase]}` };
  }

  function render() {
    if (!button) return;
    const { cls, icon, text } = statusInfo();
    button.className = cls;
    button.textContent = icon;
    button.title = text;
    button.setAttribute("aria-label", text);
  }

  // ------------------------------------------------------------------ 提示

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    // 重复点击重新计时：先清掉上一次的定时器。
    if (toastTimer !== null) clearTimeout(toastTimer);
    positionToast();
    // 先取出布局再显示，保证过渡生效。
    void toast.offsetWidth;
    toast.classList.add("is-visible");
    toastTimer = setTimeout(() => {
      toastTimer = null;
      if (toast) toast.classList.remove("is-visible");
    }, TOAST_MS);
  }

  // ------------------------------------------------------------------ 定位

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  /**
   * 按当前播放器容器的位置把按钮 / 滑块 / 提示摆好。
   * 按钮与滑块在“非直播间”或播放器不存在时隐藏；滑块额外要求插件音频已存在。
   */
  function position() {
    if (!button) return;
    const rect = isRoomPage() ? findPlayerBox() : null;
    if (!rect) {
      button.hidden = true;
      hideSlider();
      hideToast();
      return;
    }
    const maxX = window.innerWidth - BUTTON_SIZE - 4;
    const maxY = window.innerHeight - BUTTON_SIZE - 4;
    const x = clamp(rect.left + OFFSET.x, 4, maxX);
    const y = clamp(rect.top + OFFSET.y, 4, maxY);
    button.hidden = false;
    button.style.left = `${Math.round(x)}px`;
    button.style.top = `${Math.round(y)}px`;

    // 滑块紧贴按钮右侧，同一行垂直居中。
    // 只有「插件开启 **且** 插件音频已存在」时才显示：插件关闭时音频正在被拆掉，
    // 这里直接按关闭状态收起，不必等下一次 sync（否则会留下一个没有作用的滑块）。
    if (slider) {
      if (!enabled || !hasPluginAudio()) {
        hideSlider();
      } else {
        const sx = x + BUTTON_SIZE + SLIDER_GAP;
        const sy = y + (BUTTON_SIZE - SLIDER_SIZE.h) / 2;
        slider.hidden = false;
        slider.style.left = `${Math.round(clamp(sx, 4, window.innerWidth - SLIDER_SIZE.w - 4))}px`;
        slider.style.top = `${Math.round(clamp(sy, 4, window.innerHeight - SLIDER_SIZE.h - 4))}px`;
        syncSliderValue();
      }
    }
    positionToast();
  }

  function hideSlider() {
    if (slider) slider.hidden = true;
  }

  function hideToast() {
    if (!toast) return;
    toast.classList.remove("is-visible");
    toast.hidden = true;
  }

  /** 把 storage 里的音量反映到滑块上（拖拽中不要回写，否则会打断拖动）。 */
  function syncSliderValue() {
    if (!slider || draggingVolume) return;
    const next = String(Math.round(volume * 100));
    if (slider.value !== next) slider.value = next;
  }

  /** 提示贴在按钮正下方，不遮挡播放器也不接受点击（pointer-events:none）。 */
  function positionToast() {
    if (!toast || toast.hidden || !button || button.hidden) return;
    const btn = button.getBoundingClientRect();
    const width = toast.offsetWidth || 120;
    const x = clamp(btn.left, 4, window.innerWidth - width - 4);
    const y = clamp(btn.bottom + 6, 4, window.innerHeight - 28);
    toast.style.left = `${Math.round(x)}px`;
    toast.style.top = `${Math.round(y)}px`;
  }

  /** 滚动 / 改窗口时跟手，不等到下一次 sync。 */
  function schedulePosition() {
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(() => {
      repositionScheduled = false;
      position();
    });
  }

  // ------------------------------------------------------------------ 开关

  /** 只写 storage：service worker 与 audio-player 都由 storage 变更驱动，状态只有这一个来源。 */
  async function toggle() {
    if (toggling) return;
    toggling = true;
    const next = !enabled;
    enabled = next; // 先乐观更新，storage 监听随后会再同步一次
    render();
    position(); // 关闭时立即收起音量滑块，不等下一次 sync
    try {
      await chrome.storage.local.set({ enabled: next });
      showToast(next ? "省流量模式已开启" : "省流量模式已关闭");
    } catch {
    } finally {
      toggling = false;
    }
  }

  /** 按钮在我们自己的 UI 上：不要让点击传到 B站播放器（避免误触播放/暂停）。 */
  function stop(event) {
    event.stopPropagation();
  }

  // ------------------------------------------------------------------ 音量

  /**
   * 音量滑块：只改**插件自己的** <audio>.volume，并写 storage.volume 供持久化。
   * 不碰 B站原生播放器、不触发开关、不重新取流、不重建任何播放对象。
   */
  function applyVolume(raw) {
    const n = Number(raw);
    volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 1;
    const el = document.querySelector(ELEMENT_SELECTOR);
    if (el) {
      try {
        el.volume = volume;
      } catch {}
    }
    render(); // 音量为 0 时按钮图标变 🔇
    try {
      void chrome.storage.local.set({ [VOLUME_KEY]: volume });
    } catch {}
  }

  function clampVolume(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  }

  // ------------------------------------------------------------------ 挂载

  /** 样式放 head：放在按钮内部会让 textContent 混进 CSS 文本，也会随按钮一起被移除。 */
  function ensureStyle() {
    if (document.getElementById(`${BADGE_ID}-style`)) return;
    const style = document.createElement("style");
    style.id = `${BADGE_ID}-style`;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function createButton() {
    const el = document.createElement("div");
    el.id = BADGE_ID;
    el.setAttribute(OWN_UI_ATTR, "1");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.hidden = true;

    el.addEventListener("click", (event) => {
      stop(event);
      event.preventDefault();
      void toggle();
    });
    el.addEventListener("keydown", (event) => {
      stop(event);
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void toggle();
      }
    });
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
      el.addEventListener(type, stop);
    }

    document.body.appendChild(el);
    button = el;
  }

  function createSlider() {
    const el = document.createElement("input");
    el.id = SLIDER_ID;
    el.setAttribute(OWN_UI_ATTR, "1");
    el.setAttribute("type", "range");
    el.setAttribute("min", "0");
    el.setAttribute("max", "100");
    el.setAttribute("step", "1");
    el.setAttribute("aria-label", "插件音量");
    el.title = "插件音量";
    el.hidden = true;

    el.addEventListener("input", () => {
      applyVolume(el.value);
    });
    // 拖拽期间不要让 storage 回写把滑块拽回去
    el.addEventListener("pointerdown", (event) => {
      draggingVolume = true;
      stop(event);
    });
    const endDrag = () => {
      draggingVolume = false;
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("blur", endDrag);
    // 插件 UI：不能让这些事件被当成“页面手势”，也不能传到 B站播放器
    for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "change"]) {
      el.addEventListener(type, stop);
    }

    document.body.appendChild(el);
    slider = el;
    syncSliderValue();
  }

  function createToast() {
    const el = document.createElement("div");
    el.id = TOAST_ID;
    el.setAttribute(OWN_UI_ATTR, "1");
    el.setAttribute("role", "status");
    el.hidden = true;
    document.body.appendChild(el);
    toast = el;
  }

  /** 保证三个节点各自只有一份（B站重建 DOM、脚本重复注入都可能留下旧节点）。 */
  function ensureNodes() {
    const known = { [BADGE_ID]: () => button, [SLIDER_ID]: () => slider, [TOAST_ID]: () => toast };
    for (const [id, get] of Object.entries(known)) {
      const nodes = document.querySelectorAll(`#${id}`);
      for (let i = 1; i < nodes.length; i++) nodes[i].remove();
      if (nodes.length && nodes[0] !== get()) nodes[0].remove();
    }
    if (button && !button.isConnected) button = null;
    if (slider && !slider.isConnected) slider = null;
    if (toast && !toast.isConnected) toast = null;
    if (!button) createButton();
    if (!slider) createSlider();
    if (!toast) createToast();
  }

  function sync() {
    if (!document.body) return;
    ensureStyle();
    ensureNodes();
    position();
    render();
  }

  chrome.storage.local
    .get({ enabled: false, [VOLUME_KEY]: 1, [AUDIO_STATUS_KEY]: null })
    .then((stored) => {
      enabled = Boolean(stored.enabled);
      volume = clampVolume(stored[VOLUME_KEY]);
      phase = stored[AUDIO_STATUS_KEY]?.phase ?? null;
      sync();
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      enabled = Boolean(changes.enabled.newValue);
      if (!toggling) render();
      position(); // popup 关闭插件时同样立刻收起滑块
    }
    if (changes[VOLUME_KEY]) {
      volume = clampVolume(changes[VOLUME_KEY].newValue);
      syncSliderValue();
      render();
    }
    if (changes[AUDIO_STATUS_KEY]) {
      phase = changes[AUDIO_STATUS_KEY].newValue?.phase ?? null;
      render();
    }
  });

  // 播放器是异步插入的，且会被 B站重建；纯 UI，低频重试即可。
  setInterval(sync, 2000);
  window.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("pageshow", () => sync());
})();
