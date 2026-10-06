/**
 * 服务 worker：持有拦截层与统计。
 *
 * 只做两件事：
 *   1. 让 declarativeNetRequest 动态规则跟随开关状态。
 *   2. 报告规则实际拦住了多少直播媒体请求。
 *
 * 判决本身在 detector 模块里，这里只负责“应用判决”。
 */

import {
  BLOCK_MODES,
  BLOCK_MODE_REGEX,
  LIVE_STREAM_PATH,
  AUDIO_ALLOW_REGEX,
  buildAudioOnlyPlayInfoUrl,
  pickAudioOnlyStream,
} from "../shared/bilibili-signatures.js";

/** 默认状态：关闭，因此刚安装时不会改变 B站任何行为。 */
const DEFAULT_SETTINGS = {
  enabled: false,
  blockMode: BLOCK_MODES.ALL,
  blockedCount: 0,
  firstBlockedAt: null,
};

const RESOURCE_TYPES = ["xmlhttprequest", "media", "other", "object", "sub_frame"];

// ---------------------------------------------------------------- settings

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
  return getSettings();
}

// ---------------------------------------------------------------- rule sync

/**
 * Build the ruleset used when blocking is enabled.
 *
 * Rules are generated from the shared signature constants rather than written by
 * hand, so a change to the detector cannot silently desync the rules.
 * The regex strings are shared with the JS detector by construction.
 */
function buildRules(blockMode = BLOCK_MODES.ALL) {
  const regexFilter = BLOCK_MODE_REGEX[blockMode] ?? BLOCK_MODE_REGEX[BLOCK_MODES.ALL];
  return [
    {
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        regexFilter,
        resourceTypes: RESOURCE_TYPES,
      },
    },
    {
      // V2：插件自己取回来的 App 端纯音频 FLV 必须放行，否则会被上面那条一起拦掉
      // （两者路径形状完全相同，都是 /live-bvc/.../live_xxx_2500.flv）。
      //
      // 结构是「默认拦 + 精确放」，而不是把上面那条改成「只拦 pt=web」：
      // 后者一旦 B站改了 Web 播放器的参数，整条视频流会静默漏过去。
      // 判据 pt=android 来自 B站自己生成的 CDN URL（实测 Web 播放器是 pt=web），
      // 详见 shared/bilibili-signatures.js 的 AUDIO_ONLY_QUERY_MARKER。
      id: 2,
      priority: 2,
      action: { type: "allow" },
      condition: {
        regexFilter: AUDIO_ALLOW_REGEX,
        resourceTypes: RESOURCE_TYPES,
      },
    },
  ];
}

/**
 * The shipped rules file is disabled by default, so that a fresh install has no
 * effect on Bilibili. Actual blocking is applied through dynamic rules, which
 * makes the current state explicit and easy to inspect.
 */
async function applyBlockingState(enabled, blockMode = BLOCK_MODES.ALL) {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: enabled ? buildRules(blockMode) : [],
    });
    return { ok: true, ruleCount: (await chrome.declarativeNetRequest.getDynamicRules()).length };
  } catch (error) {
    console.error("[video-blocker] failed to apply blocking state:", error);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Quick self-check that the interception layer is intact. */
async function describeState() {
  const settings = await getSettings();
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  return {
    enabled: settings.enabled,
    blockMode: settings.blockMode,
    activeRuleCount: dynamic.length,
    rules: dynamic.map((r) => ({ id: r.id, regexFilter: r.condition?.regexFilter })),
    blockedCount: settings.blockedCount,
    firstBlockedAt: settings.firstBlockedAt,
    liveStreamPath: LIVE_STREAM_PATH,
  };
}

// ---------------------------------------------------------------- statistics

/**
 * Count blocked requests.
 *
 * declarativeNetRequest cannot report the byte size of a request it blocked, so
 * this deliberately records only a count. Any "saved traffic" figure must be
 * derived from an explicit, clearly-labelled estimate elsewhere (see README).
 */
const MATCHED_RULE_QUERY = {};

async function collectMatchedRuleStats({ reset = false } = {}) {
  try {
    const result = await chrome.declarativeNetRequest.getMatchedRules(MATCHED_RULE_QUERY);
    const matches = result?.rulesMatchedInfo ?? [];
    if (!matches.length) return { added: 0, total: (await getSettings()).blockedCount };

    const settings = await getSettings();
    const added = matches.length;
    const patch = {
      blockedCount: (settings.blockedCount ?? 0) + added,
      firstBlockedAt: settings.firstBlockedAt ?? Date.now(),
    };
    await setSettings(patch);
    if (reset) await chrome.declarativeNetRequest.setMatchedRules({});
    return { added, total: patch.blockedCount };
  } catch (error) {
    // getMatchedRules needs the declarativeNetRequestFeedback permission and an
    // unpacked/developer-mode install; report the failure instead of hiding it.
    return { error: String(error?.message ?? error) };
  }
}

// ------------------------------------------------------- V2 纯音频取流

/**
 * 取当前直播间的纯音频 FLV 地址。
 *
 * 走 App 端接口（web-room 接口不提供纯音频流），由内容脚本按需调用。
 * 放在 service worker 里的原因有两个：
 *   1. B站相关知识只有 module 能 import，内容脚本是经典脚本；
 *   2. 这里可以直接拿到 host_permissions 覆盖的跨域请求，不必依赖页面 CORS。
 * 实测该接口不需要 Cookie、不需要 Referer、不需要签名。
 *
 * 每次调用都返回全新 URL（带新的 ts 与新的 CDN 节点），绝不缓存复用：
 * 实测 URL 带 expires，有效期约 1 小时，且部分 CDN 节点会对 FLV 返回 403，
 * 重新请求是唯一可靠的换节点手段。
 */
const AUDIO_RESOLVE_TIMEOUT_MS = 15000;

async function resolveAudioStream(roomId) {
  const room = String(roomId ?? "");
  if (!/^\d+$/.test(room)) return { ok: false, error: "房间号无效" };

  let json;
  try {
    const response = await fetch(buildAudioOnlyPlayInfoUrl(room), {
      cache: "no-store",
      signal: AbortSignal.timeout(AUDIO_RESOLVE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: `取流接口 HTTP ${response.status}` };
    json = await response.json();
  } catch (error) {
    return { ok: false, error: `取流请求失败：${String(error?.message ?? error)}` };
  }

  if (json?.code !== 0) {
    return { ok: false, error: `取流接口错误 ${json?.code} ${json?.message ?? ""}`.trim() };
  }
  if (json?.data?.live_status === 0) return { ok: false, error: "直播间当前未开播" };

  const picked = pickAudioOnlyStream(json);
  if (!picked) return { ok: false, error: "未找到纯音频 FLV 流" };
  return { ok: true, ...picked };
}

// ---------------------------------------------------------------- lifecycle

/**
 * 验证用覆写：本地测试器可以在启动时决定屏蔽开关，从而在无人值守的自动化
 * 测试中对比“关闭 / 开启”两种状态。测试器未运行时该请求失败，插件正常回落到
 * 用户保存的设置。
 */
const VERIFY_OVERRIDE_URL = "http://127.0.0.1:8791/state";

/** 测试器覆写是否生效。生效期间它优先于用户设置，避免两边互相覆盖。 */
let verificationOverrideActive = false;

async function readVerificationOverride() {
  try {
    const res = await fetch(VERIFY_OVERRIDE_URL, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.enabled !== "boolean") return null;
    return { enabled: data.enabled, blockMode: data.blockMode ?? BLOCK_MODES.ALL };
  } catch {
    return null;
  }
}

async function bootstrap() {
  const override = await readVerificationOverride();
  if (override) {
    verificationOverrideActive = true;
    console.info(
      `[video-blocker] verification override active: enabled=${override.enabled} mode=${override.blockMode}`,
    );
    await applyBlockingState(override.enabled, override.blockMode);
    return;
  }
  verificationOverrideActive = false;
  const settings = await getSettings();
  await applyBlockingState(settings.enabled, settings.blockMode);
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap().catch((e) => console.error("[video-blocker] install bootstrap failed", e));
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap().catch((e) => console.error("[video-blocker] startup bootstrap failed", e));
});

// Keep the service worker honest even if neither event fires in a session.
bootstrap().catch((e) => console.error("[video-blocker] bootstrap failed", e));

/**
 * 让 DNR 规则与 enabled/blockMode 的实际取值保持一致。
 *
 * 为什么需要：此前只有 popup 发来的 setEnabled 消息才会写规则，
 * 于是任何不经该消息的开关变更（例如页面侧测试入口直接写 storage）都不会
 * 让规则生效——规则停在上一次的状态。加上这个监听后，
 * storage 成为开关的唯一事实来源：
 *   写 storage → 这里同步 DNR 规则
 *              → content script 的 storage 监听同步终止已有播放
 * 两条路径由同一个事件驱动，不会脱节。
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.enabled && !changes.blockMode) return;
  // 测试器覆写生效期间由它决定规则，避免与测试意图互相覆盖。
  if (verificationOverrideActive) return;
  void (async () => {
    const settings = await getSettings();
    const applied = await applyBlockingState(settings.enabled, settings.blockMode);
    if (!applied.ok) console.error("[video-blocker] 规则同步失败:", applied.error);
  })().catch((e) => console.error("[video-blocker] 规则同步异常", e));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "getState":
        sendResponse(await describeState());
        return;
      case "setEnabled": {
        const patch = { enabled: Boolean(message.enabled) };
        if (message.blockMode) patch.blockMode = message.blockMode;
        const settings = await setSettings(patch);
        const applied = await applyBlockingState(settings.enabled, settings.blockMode);
        sendResponse({ ...(await describeState()), applied });
        return;
      }
      case "resolveAudioStream":
        sendResponse(await resolveAudioStream(message.roomId));
        return;
      case "collectStats":
        sendResponse(await collectMatchedRuleStats({ reset: true }));
        return;
      case "resetStats":
        await setSettings({ blockedCount: 0, firstBlockedAt: null });
        try {
          await chrome.declarativeNetRequest.setMatchedRules({});
        } catch {}
        sendResponse(await describeState());
        return;
      default:
        sendResponse({ error: `unknown message type: ${message?.type}` });
    }
  })().catch((error) => {
    try {
      sendResponse({ error: String(error?.message ?? error) });
    } catch {}
  });
  return true; // keep the channel open for the async response
});
