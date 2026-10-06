/**
 * popup.js —— 只负责显示状态与开关，不参与任何拦截逻辑。
 *
 * 关于“估算节省流量”：declarativeNetRequest 不会告诉你被阻止的请求有多大，
 * 所以这里不伪装成精确值。做法是用实测得到的平均码率 × 累计屏蔽时长，
 * 并明确标注为估算。
 */

const REFRESH_MS = 2000;
/** 统计来自 declarativeNetRequest.getMatchedRules，低频拉取即可。 */
const COLLECT_MS = 5000;

/** 实测码率参考（见 README 的实测数据）。仅用于估算，会随直播间画质变化。 */
const ESTIMATED_BITRATE_BPS = 2_700_000; // 实测 12 秒 FLV 平均 2.707 Mbps ≈ 0.32 MB/s

const el = {
  toggle: document.getElementById("toggle"),
  statusLine: document.getElementById("status-line"),
  videoState: document.getElementById("video-state"),
  audioState: document.getElementById("audio-state"),
  danmakuState: document.getElementById("danmaku-state"),
  blockedCount: document.getElementById("blocked-count"),
  savedBytes: document.getElementById("saved-bytes"),
  uptime: document.getElementById("uptime"),
  pageHint: document.getElementById("page-hint"),
  audioDetail: document.getElementById("audio-detail"),
  reset: document.getElementById("reset"),
};

/**
 * V2 纯音频播放器的状态 → popup 文案。
 * 阶段名来自 content/audio-player.js 的 report()，两边必须一致。
 */
const AUDIO_PHASE_LABEL = {
  idle: { text: "未播放", kind: "muted" },
  resolving: { text: "获取纯音频流…", kind: "muted" },
  playing: { text: "纯音频播放中", kind: "ok" },
  retrying: { text: "重试中", kind: "bad" },
  failed: { text: "不可用", kind: "bad" },
  blocked: { text: "等待页面交互", kind: "bad" },
};

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function setStateLabel(node, text, kind) {
  node.textContent = text;
  node.className = kind ?? "muted";
}

async function render() {
  const state = await send({ type: "getState" });
  const { liveSnapshot, audioStatus } = await chrome.storage.local.get({
    liveSnapshot: null,
    audioStatus: null,
  });

  if (!state) {
    el.statusLine.textContent = "无法连接到后台服务";
    el.statusLine.className = "status off";
    return;
  }

  el.toggle.checked = Boolean(state.enabled);
  el.statusLine.textContent = state.enabled ? "🟢 视频屏蔽：已开启" : "⚪ 视频屏蔽：已关闭";
  el.statusLine.className = state.enabled ? "status" : "status off";

  // 屏蔽时长：从第一次拦住请求开始算。
  const shieldingMs = state.firstBlockedAt ? Date.now() - state.firstBlockedAt : 0;
  el.blockedCount.textContent = String(state.blockedCount ?? 0);
  el.uptime.textContent = state.enabled ? formatDuration(shieldingMs) : "—";
  el.savedBytes.textContent =
    state.enabled && shieldingMs > 0
      ? `约 ${formatBytes((ESTIMATED_BITRATE_BPS / 8) * (shieldingMs / 1000))}`
      : "—";

  // 页面状态。
  const onRoom = Boolean(liveSnapshot?.isLiveRoomPage);
  el.pageHint.textContent = onRoom
    ? liveSnapshot.liveStatusText
      ? `直播间状态：${liveSnapshot.liveStatusText}`
      : "已在直播间页面"
    : "当前不在 B站直播间";

  if (!state.enabled) {
    setStateLabel(el.videoState, "正常（未屏蔽）", "ok");
    setStateLabel(el.audioState, "正常", "ok");
    el.audioDetail.textContent = "音频：由 B站播放器正常播放";
  } else {
    // 区分“已经真正停止了播放”与“只是拦到了新请求”：
    // 两者都算修好，但含义不同，如实区分显示。
    const mediaStopped = Boolean(liveSnapshot?.liveVideoStopped || liveSnapshot?.liveVideoSrcCleared);
    setStateLabel(
      el.videoState,
      mediaStopped ? "已停止播放" : state.blockedCount > 0 ? "已禁止" : "等待拦截",
      mediaStopped || state.blockedCount > 0 ? "bad" : "muted",
    );

    // V2：音频不再随视频一起消失，而是由插件自己拉取的纯音频流播放。
    // 状态一律来自 audio-player.js 的实际上报，不做推测。
    if (!onRoom) {
      setStateLabel(el.audioState, "—", "muted");
      el.audioDetail.textContent = "音频：当前不在直播间";
    } else if (!audioStatus?.phase) {
      setStateLabel(el.audioState, "启动中…", "muted");
      el.audioDetail.textContent = "音频：等待播放器上报状态";
    } else {
      const meta = AUDIO_PHASE_LABEL[audioStatus.phase] ?? { text: audioStatus.phase, kind: "muted" };
      setStateLabel(el.audioState, meta.text, meta.kind);
      const host = audioStatus.host ? ` · ${audioStatus.host}` : "";
      const retries = audioStatus.retries ? ` · 已重试 ${audioStatus.retries} 次` : "";
      el.audioDetail.textContent = `音频：${audioStatus.detail || meta.text}${host}${retries}`;
    }
  }

  setStateLabel(
    el.danmakuState,
    onRoom ? (liveSnapshot.danmakuPresent ? "正常" : "未检测到") : "—",
    onRoom && liveSnapshot.danmakuPresent ? "ok" : "muted",
  );
}

el.toggle.addEventListener("change", async () => {
  el.statusLine.textContent = "正在应用…";
  await send({ type: "setEnabled", enabled: el.toggle.checked });
  await render();
});

el.reset.addEventListener("click", async () => {
  await send({ type: "resetStats" });
  await render();
});

void render();
setInterval(() => void render(), REFRESH_MS);

/**
 * 统计收集：DNR 不会主动推送命中数，需要主动查询 getMatchedRules 并按增量累加。
 * 这里只负责“定期问一次”，累加逻辑在 service worker 里。
 */
async function collect() {
  const result = await send({ type: "collectStats" });
  if (result?.error) {
    // 未打包安装或缺少 declarativeNetRequestFeedback 时统计不可用，如实提示。
    console.warn("[video-blocker] 统计不可用:", result.error);
  }
}

void collect();
setInterval(() => void collect(), COLLECT_MS);
