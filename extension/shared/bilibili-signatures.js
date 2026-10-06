/**
 * B站特定逻辑集中在此文件。
 *
 * 本文件中的判断全部来自实测（2026-10-05，Edge 154 / Chromium 154，
 * 基于 api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo 与真实 CDN 响应），
 * 不是猜测。B站改版时，原则上只需要修改本文件。
 *
 * 实测到的直播流形态：
 *
 *   http_stream / flv
 *     https://<cdn>/live-bvc/<id>/live_<session>_<qn>.flv?...   content-type: video/x-flv
 *
 *   http_hls / ts
 *     https://<cdn>/live-bvc/<id>/live_<session>_<qn>.m3u8?...  content-type: application/vnd.apple.mpegurl
 *     分片: live_<session>_<qn>-<timestamp>.ts                  content-type: video/mp2t
 *
 *   http_hls / fmp4
 *     https://<cdn>/live-bvc/<id>/live_<session>_<qn>/index.m3u8?...
 *     初始化分片: h<id>.m4s
 *     分片: <seq>.m4s                                           content-type: application/octet-stream
 *
 * 两个关键实测结论：
 *
 * 1) 音视频复用。播放器只创建一个 SourceBuffer，其 MIME 为
 *      video/mp4; codecs="av01.0.08M.08,mp4a.40.2"
 *    fMP4 初始化分片的 moov 同时包含 'vide' 与 'soun' 两条 track。
 *    playurl 响应中不存在纯音频流。所以在网络层只能整体放行或整体阻止，
 *    “只禁视频、保住 B站自己的音频”无法实现。详见 README。
 *
 * 2) 必须按路径 /live-bvc/ 匹配，不能只按域名后缀匹配。
 *    播放器在直连 CDN 失败后会走镜像代理，例如
 *      https://a5fc91355286fb2e8dc224adc9bc5e15.h2.smtcdns.net/d1--cn-gotcha204b.bilivideo.com/live-bvc/...
 *    即“任意代理域名 + 原始 CDN 域名 + /live-bvc/ + 媒体文件”。
 *    实测中这条路径提供过 69 个请求 / 1.34 MB 的媒体数据。
 *    只匹配 *.bilivideo.com 会把镜像路径漏掉，导致视频照常播放。
 *
 * 因此：/live-bvc/ 是可靠的、与域名无关的直播媒体路径标记；
 * 实测它在页面与 playurl 数据中只用于直播媒体，不会误伤其他 B站资源。
 */

/** 所有 B站直播媒体流共用的路径前缀（实测唯一可靠的标记）。 */
export const LIVE_STREAM_PATH = "/live-bvc/";

/** B站直播直连 CDN 的域名后缀（仅作诊断参考，不作为唯一判据）。 */
export const CDN_HOST_SUFFIXES = [".bilivideo.com", ".bilivideo.cn"];

/** 直播媒体分片的扩展名。 */
export const LIVE_MEDIA_EXTENSIONS = [".flv", ".m3u8", ".m4s", ".ts", ".fmp4", ".mpd"];

/**
 * 阻止策略：拦住“哪一层”。两种都拦得住视频数据，但对播放器的影响不同，
 * 由实测选择（见 README 的策略对比）。
 */
export const BLOCK_MODES = {
  MANIFEST: "manifest",
  SEGMENTS: "segments",
  ALL: "all",
};

/**
 * 与 isLiveMediaUrl() 等价的 declarativeNetRequest regexFilter。
 *
 * 关键点一：/live-bvc/ 之前必须用 `.*` 而不是 `[^/]*`。
 *   镜像代理 URL 在 /live-bvc/ 之前有两段以 / 分隔的内容：
 *     https://<代理域名>/<原始CDN域名>/live-bvc/...
 *   `[^/]*` 不能跨越 `/`，会把这类 URL 漏掉（实测漏拦后视频照常播放）。
 *
 * 关键点二：主机部分不做域名限制，只依赖 /live-bvc/ 这个路径标记，
 *   否则镜像代理域名同样会被漏掉。
 */
const LIVE_PATH_REGEX_PREFIX = "^https?://.*/live-bvc/";

export const BLOCK_MODE_REGEX = {
  // 只拦 HLS 清单
  [BLOCK_MODES.MANIFEST]: `${LIVE_PATH_REGEX_PREFIX}.*\\.m3u8(?:\\?|$)`,
  // 只拦媒体分片，放行清单
  [BLOCK_MODES.SEGMENTS]: `${LIVE_PATH_REGEX_PREFIX}.*\\.(?:flv|m4s|ts)(?:\\?|$)`,
  // 清单与分片都拦
  [BLOCK_MODES.ALL]: `${LIVE_PATH_REGEX_PREFIX}.*\\.(?:flv|m3u8|m4s|ts)(?:\\?|$)`,
};

/** 默认策略。 */
export const DEFAULT_BLOCK_MODE = BLOCK_MODES.ALL;

/**
 * 判断一个 URL 是否属于 B站直播媒体流。
 *
 * 判据：路径中包含 /live-bvc/，且路径以直播媒体扩展名结尾。
 * 不看域名，因为存在镜像代理域名；不看签名参数，因为 oi/expires/upsig 会变化。
 */
export function isLiveMediaUrl(urlString) {
  let url;
  try {
    url = new URL(urlString, "https://live.bilibili.com");
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!url.pathname.toLowerCase().includes(LIVE_STREAM_PATH)) return false;

  const path = url.pathname.toLowerCase();
  return LIVE_MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/* ========================================================================
 * V2：纯音频流（2026-10-06 实测确认）
 *
 * Web 播放器用的 web-room 接口不提供纯音频流，且 only_audio 参数无效。
 * 真正的纯音频流只出现在 App 端接口：
 *   xlive/app-room/v2/index/getRoomPlayInfo  +  only_audio=1
 * 且只有 http_stream / flv 这一条会变成纯音频（实测 FLV flags=0x4，video tag = 0）；
 * http_hls（ts / fmp4）即使加了 only_audio=1 仍是音视频双轨，不能使用。
 *
 * 重要：不能依据响应里的 video_codecs / audio_codecs 字段判断是否纯音频，
 * 实测这两个字段在纯音频流上依然写着 avc1.64001f + mp4a.40.2，与复用流完全相同。
 * ====================================================================== */

/** App 端播放信息接口。 */
export const APP_ROOM_PLAYINFO_API =
  "https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo";

/**
 * App 端取纯音频流所需的完整参数（实测可复现）。
 * 不依赖登录态，不需要 Cookie，也不需要签名。
 */
export const AUDIO_ONLY_APP_PARAMS = {
  appkey: "iVGUTjsxvpLeuDCf",
  build: "6215200",
  c_locale: "zh_CN",
  channel: "bili",
  codec: "0",
  device: "android",
  device_name: "VTR-AL00",
  dolby: "1",
  format: "0,2",
  free_type: "0",
  http: "1",
  mask: "0",
  mobi_app: "android",
  network: "wifi",
  no_playurl: "0",
  only_audio: "1",
  only_video: "0",
  platform: "android",
  play_type: "0",
  protocol: "0,1",
  qn: "10000",
  s_locale: "zh_CN",
  statistics: '{"appId":1,"platform":3,"version":"6.21.5","abtest":""}',
};

/** 组装 App 端纯音频取流地址。每次进房间都要重新请求，URL 有短期有效期。 */
export function buildAudioOnlyPlayInfoUrl(roomId, nowSeconds = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    ...AUDIO_ONLY_APP_PARAMS,
    ts: String(nowSeconds),
    room_id: String(roomId),
  });
  return `${APP_ROOM_PLAYINFO_API}?${params.toString()}`;
}

/**
 * 区分 Web 播放器与 App 端取流请求的查询参数标记（实测）。
 *
 *   Web 播放器的复用流 : ...&pt=web&...                    （无 platform / ptype）
 *   App 端纯音频流     : ...&pt=android&...&ptype=1&...     （无 platform 字段）
 *
 * 两者路径形状完全相同（都是 /live-bvc/<桶号>/live_<session>_<qn>.flv），
 * 只有这个标记能把它们分开。
 */
export const AUDIO_ONLY_QUERY_MARKER = "pt=android";
export const WEB_PLAYER_QUERY_MARKER = "pt=web";

/**
 * DNR 放行规则的 regexFilter：只放行 App 端纯音频 FLV。
 *
 * 结构上是「默认拦截 + 精确放行」，而不是「改成只拦 pt=web」——
 * 后者一旦 B站改了 Web 播放器的参数就会静默漏掉整条视频流。
 */
export const AUDIO_ALLOW_REGEX = `^https?://.*/live-bvc/.*\\.flv\\?.*[?&]${AUDIO_ONLY_QUERY_MARKER}(?:&|$)`;

/** 这个 URL 是否是我们自己的纯音频流。 */
export function isAudioOnlyStreamUrl(urlString) {
  try {
    const url = new URL(urlString, "https://live.bilibili.com");
    if (!/\.flv$/i.test(url.pathname)) return false;
    if (!url.pathname.toLowerCase().includes(LIVE_STREAM_PATH)) return false;
    const pt = url.searchParams.get("pt");
    return pt === "android";
  } catch {
    return false;
  }
}

/** 从 URL 上读取有效期（unix 秒）。实测有效期约 1 小时。 */
export function parseStreamExpiry(urlString) {
  try {
    const expires = Number(new URL(urlString).searchParams.get("expires"));
    return Number.isFinite(expires) && expires > 0 ? expires : null;
  } catch {
    return null;
  }
}

/**
 * 从 App 端 playurl 响应里取出纯音频 FLV URL。
 *
 * 只接受 http_stream / flv（实测唯一会变成纯音频的组合）。
 * 不读取 video_codecs / audio_codecs —— 那两个字段在纯音频流上也是错的。
 *
 * @returns {{url: string, host: string, session: string|null, expiresAt: number|null}|null}
 */
export function pickAudioOnlyStream(playInfo) {
  const streams = playInfo?.data?.playurl_info?.playurl?.stream;
  if (!Array.isArray(streams)) return null;

  for (const stream of streams) {
    if (stream?.protocol_name !== "http_stream") continue;
    for (const format of stream.format ?? []) {
      if (format?.format_name !== "flv") continue;
      for (const codec of format.codec ?? []) {
        const infos = Array.isArray(codec?.url_info) ? codec.url_info : [];
        if (!codec?.base_url || !infos.length) continue;

        // 优先 https 主机；CDN 有时返回 http://，页面是 https 会被 mixed content 拦掉。
        const usable = infos
          .filter((u) => typeof u?.host === "string" && u.host)
          .sort((a, b) => Number(b.host.startsWith("https://")) - Number(a.host.startsWith("https://")));
        if (!usable.length) continue;

        // 返回全部候选主机：实测部分省级 CDN 节点会对 FLV 直接 403，
        // 同一个响应里的其它节点往往可用，先把它们用尽再重新请求接口换一批。
        const urls = usable.map((u) =>
          (u.host + codec.base_url + (u.extra ?? "")).replace(/^http:/, "https:"),
        );
        return {
          url: urls[0],
          urls,
          host: usable[0].host,
          session: codec.session ?? null,
          expiresAt: parseStreamExpiry(urls[0]),
        };
      }
    }
  }
  return null;
}

/** 从直播页路径里取房间号。支持 /12345 与 /blanc/12345。 */
export function parseLiveRoomId(pathname) {
  const match = /^\/(?:blanc\/)?(\d+)(?:\/|$)/.exec(String(pathname ?? ""));
  return match ? match[1] : null;
}

/**
 * 仅用于诊断：解释某个 URL 为什么被放行或被阻止。
 */
export function explainLiveMediaUrl(urlString) {
  let url;
  try {
    url = new URL(urlString, "https://live.bilibili.com");
  } catch {
    return { host: null, livePath: false, extension: null, isLiveMedia: false };
  }
  const path = url.pathname.toLowerCase();
  const ext = LIVE_MEDIA_EXTENSIONS.find((e) => path.endsWith(e)) ?? null;
  const host = url.hostname.toLowerCase();
  return {
    host,
    livePath: path.includes(LIVE_STREAM_PATH),
    extension: ext,
    isLiveMedia: isLiveMediaUrl(urlString),
    directCdn: CDN_HOST_SUFFIXES.some((s) => host.endsWith(s)),
    // 形如 <hash>.h2.smtcdns.net/<原始CDN域名>/live-bvc/... 的镜像代理路径
    mirrorProxy: !CDN_HOST_SUFFIXES.some((s) => host.endsWith(s)) && path.includes(LIVE_STREAM_PATH),
  };
}
