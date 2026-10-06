/**
 * 视频请求识别器 VideoRequestDetector
 *
 * 唯一负责回答“这个请求该不该被阻止”的地方。
 *
 * 设计原则：
 *   - 判决集中在这里，调用方不再自己写 URL 匹配。
 *   - B站相关的 URL 知识全部来自 shared/bilibili-signatures.js。
 *   - 每次判决都给出原因，便于验证与排查。
 *
 * 范围说明（实测结论）：B站直播不提供纯音频流，每一种可播放的流都是音视频复用
 * （FLV 单连接复用；HLS fMP4 的 init 分片同时声明 'vide' 与 'soun'）。
 * 因此本识别器针对的是“整条直播媒体流”，音频的代价是实测出来的结果，
 * 而不是被隐藏的副作用。详见 README。
 */

import {
  BLOCK_MODES,
  DEFAULT_BLOCK_MODE,
  isLiveMediaUrl,
  explainLiveMediaUrl,
} from "../shared/bilibili-signatures.js";

export const Reason = {
  DISABLED: "disabled",
  NOT_LIVE_MEDIA: "not_live_media",
  LIVE_MEDIA: "bilibili_live_media",
};

/** 把 URL 归类到当前策略关心的那一层。 */
function classify(url) {
  const path = new URL(url, "https://live.bilibili.com").pathname.toLowerCase();
  return path.endsWith(".m3u8") ? BLOCK_MODES.MANIFEST : BLOCK_MODES.SEGMENTS;
}

export class VideoRequestDetector {
  /**
   * @param {{ enabled?: boolean, blockMode?: string }} options
   */
  constructor({ enabled = false, blockMode = DEFAULT_BLOCK_MODE } = {}) {
    this.enabled = Boolean(enabled);
    this.blockMode = blockMode ?? DEFAULT_BLOCK_MODE;
  }

  configure({ enabled, blockMode } = {}) {
    if (typeof enabled === "boolean") this.enabled = enabled;
    if (blockMode) this.blockMode = blockMode;
  }

  /**
   * 判断请求是否必须被阻止。
   *
   * @param {string} url
   * @param {{ resourceType?: string }} [context]
   * @returns {{ block: boolean, reason: string, detail?: object }}
   */
  shouldBlock(url, context = {}) {
    if (!this.enabled) return { block: false, reason: Reason.DISABLED };
    if (!url || typeof url !== "string") return { block: false, reason: Reason.NOT_LIVE_MEDIA };
    if (!isLiveMediaUrl(url)) return { block: false, reason: Reason.NOT_LIVE_MEDIA };

    const layer = classify(url);
    const wanted =
      this.blockMode === BLOCK_MODES.ALL ||
      (this.blockMode === BLOCK_MODES.MANIFEST && layer === BLOCK_MODES.MANIFEST) ||
      (this.blockMode === BLOCK_MODES.SEGMENTS && layer === BLOCK_MODES.SEGMENTS);

    return wanted
      ? {
          block: true,
          reason: Reason.LIVE_MEDIA,
          detail: { layer, resourceType: context.resourceType ?? null },
        }
      : { block: false, reason: Reason.NOT_LIVE_MEDIA, detail: { layer } };
  }

  /** 诊断用：解释一个 URL，即使当前处于关闭状态。 */
  explain(url) {
    return explainLiveMediaUrl(url);
  }
}
