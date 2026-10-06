/**
 * Runs in the PAGE's own JavaScript world (injected by hook-injector.js).
 *
 * Purpose: verification instrumentation only. It answers, with ground truth,
 * the questions the acceptance criteria depend on:
 *
 *   - Which media URLs is the player really requesting, and what MIME types come back?
 *   - How many bytes actually reach the player (SourceBuffer.appendBuffer / response size)?
 *   - Does the player recover later and start downloading again?
 *   - Are audio and video ever requested as separate streams?
 *
 * It must never change playback behaviour: every hook calls through to the
 * original implementation.
 */

(() => {
  if (window.__VLB_PROBE__) return;

  const state = {
    startedAt: Date.now(),
    network: [], // media-ish requests seen through fetch/XHR
    sourceBuffers: [], // one entry per addSourceBuffer call, with appended byte totals
    mediaEvents: [],
    elementErrors: [],
    blockedByNetwork: 0,
    lastReportAt: 0,
  };
  window.__VLB_PROBE__ = state;

  const MEDIA_RE = /bilivideo|live-bvc|\.flv|\.m3u8|\.m4s|\.ts(\?|$)|\.mpd(\?|$)/i;
  const MAX_EVENTS = 60;

  const record = (list, entry) => {
    if (list.length < MAX_EVENTS) list.push(entry);
    else list[list.length - 1] = entry; // keep the newest when full
  };

  const now = () => Math.round(performance.now());

  // --------------------------------------------------------------- fetch probe
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function vlbFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const isMedia = MEDIA_RE.test(url);
      const promise = originalFetch.apply(this, arguments);
      if (!isMedia) return promise;

      const entry = { via: "fetch", url: url.slice(0, 300), at: now(), ok: null, status: null, mime: null, bytes: null };
      record(state.network, entry);

      return promise.then(
        (response) => {
          entry.ok = response.ok;
          entry.status = response.status;
          entry.mime = response.headers.get("content-type");

          // 只测量“会结束”的响应。
          //
          // 直播 FLV 是一条永不结束的流：clone().arrayBuffer() 永远不 resolve，
          // 却会把已经读到的每个字节都留在内存里。实测纯音频流约 140KB/s，
          // 一小时就是 ~500MB，长时间观看会把页面拖垮。
          //
          // V1 时期这条路径走不到（复用流被 DNR 拦掉，fetch 直接 reject），
          // V2 的纯音频流是真的会成功下载，所以必须在这里排除。
          // 清单(.m3u8)与分片(.ts/.m4s)是有界的，照常统计。
          const isUnboundedLiveFlv = /\.flv(\?|$)/i.test(url);
          if (!isUnboundedLiveFlv) {
            // Measure the payload without consuming the player's stream.
            try {
              response
                .clone()
                .arrayBuffer()
                .then((buf) => {
                  entry.bytes = buf.byteLength;
                })
                .catch(() => {});
            } catch {}
          }
          return response;
        },
        (error) => {
          entry.ok = false;
          entry.error = String(error?.message ?? error).slice(0, 160);
          state.blockedByNetwork++;
          return Promise.reject(error);
        },
      );
    };
  }

  // ---------------------------------------------------------------- XHR probe
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function vlbOpen(method, url) {
      this.__vlbUrl = String(url);
      this.__vlbIsMedia = MEDIA_RE.test(this.__vlbUrl);
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function vlbSend() {
      if (this.__vlbIsMedia) {
        const entry = { via: "xhr", url: this.__vlbUrl.slice(0, 300), at: now(), status: null, mime: null, bytes: 0 };
        record(state.network, entry);
        this.addEventListener("progress", (e) => {
          if (e.lengthComputable) entry.bytes = e.loaded;
        });
        const finish = () => {
          entry.status = this.status;
          try {
            entry.mime = this.getResponseHeader("content-type");
          } catch {}
        };
        this.addEventListener("load", finish);
        this.addEventListener("error", () => {
          entry.error = "network error";
          state.blockedByNetwork++;
        });
        this.addEventListener("abort", () => {
          entry.error = "aborted";
        });
      }
      return send.apply(this, arguments);
    };
  }

  // ----------------------------------------------------------- MediaSource probe
  const MS = window.MediaSource;
  if (MS) {
    const addSourceBuffer = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function vlbAddSourceBuffer(mime) {
      const sb = addSourceBuffer.apply(this, arguments);
      const entry = {
        mime: String(mime),
        at: now(),
        appendCalls: 0,
        appendedBytes: 0,
        ended: false,
        error: null,
      };
      record(state.sourceBuffers, entry);

      const appendBuffer = sb.appendBuffer;
      sb.appendBuffer = function vlbAppendBuffer(data) {
        try {
          entry.appendCalls++;
          entry.appendedBytes += data?.byteLength ?? data?.length ?? 0;
        } catch {}
        return appendBuffer.apply(this, arguments);
      };
      sb.addEventListener?.("error", () => {
        entry.error = "sourcebuffer error";
      });
      return sb;
    };
  }

  // ------------------------------------------------------------ media elements
  for (const proto of [window.HTMLMediaElement?.prototype, window.HTMLVideoElement?.prototype]) {
    if (!proto || proto.__vlbPatched) continue;
    proto.__vlbPatched = true;
    const play = proto.play;
    if (typeof play === "function") {
      proto.play = function vlbPlay() {
        record(state.mediaEvents, {
          type: "play() called",
          tag: this.tagName,
          src: String(this.currentSrc || this.src || "").slice(0, 160),
          at: now(),
        });
        return play.apply(this, arguments);
      };
    }
  }

  document.addEventListener(
    "error",
    (event) => {
      const el = event.target;
      if (!el || !(el instanceof HTMLMediaElement)) return;
      record(state.elementErrors, {
        tag: el.tagName,
        src: String(el.currentSrc || el.src || "").slice(0, 200),
        code: el.error?.code ?? null,
        message: String(el.error?.message ?? "").slice(0, 200),
        at: now(),
      });
    },
    true, // capture: media error events do not bubble
  );

  // --------------------------------------------------------- Resource Timing
  function resourceSummary() {
    const entries = performance.getEntriesByType("resource").filter((e) => MEDIA_RE.test(e.name));
    const byExtension = {};
    let transferTotal = 0;
    for (const e of entries) {
      const path = e.name.split("?")[0].toLowerCase();
      const ext = path.slice(path.lastIndexOf(".")) || "?";
      byExtension[ext] = byExtension[ext] ?? { count: 0, transferSize: 0, encodedBodySize: 0 };
      byExtension[ext].count++;
      byExtension[ext].transferSize += e.transferSize || 0;
      byExtension[ext].encodedBodySize += e.encodedBodySize || 0;
      transferTotal += e.transferSize || 0;
    }
    return {
      count: entries.length,
      transferTotal,
      byExtension,
      recent: entries.slice(-15).map((e) => ({
        n: e.name.slice(0, 200),
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        duration: Math.round(e.duration),
      })),
    };
  }

  function snapshot() {
    const videos = [...document.querySelectorAll("video")].map((v) => ({
      readyState: v.readyState,
      networkState: v.networkState,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      paused: v.paused,
      currentTime: Number(v.currentTime?.toFixed?.(2) ?? v.currentTime),
      duration: Number.isFinite(v.duration) ? v.duration : null,
      muted: v.muted,
      volume: v.volume,
      errorCode: v.error?.code ?? null,
      currentSrc: String(v.currentSrc || "").slice(0, 160),
      srcIsBlob: String(v.currentSrc || v.src || "").startsWith("blob:"),
      buffered: v.buffered.length
        ? { start: Number(v.buffered.start(0).toFixed(2)), end: Number(v.buffered.end(v.buffered.length - 1).toFixed(2)) }
        : null,
    }));
    const audios = [...document.querySelectorAll("audio")].map((a) => ({
      readyState: a.readyState,
      paused: a.paused,
      currentTime: Number(a.currentTime?.toFixed?.(2) ?? a.currentTime),
      errorCode: a.error?.code ?? null,
      currentSrc: String(a.currentSrc || "").slice(0, 160),
    }));
    return {
      source: "vlb-page-probe",
      at: Date.now(),
      href: location.href,
      title: document.title.slice(0, 80),
      videos,
      audios,
      mediaElements: document.querySelectorAll("video,audio").length,
      resources: resourceSummary(),
      sourceBuffers: state.sourceBuffers,
      // 累计追加字节是单调递增的：它是否继续增长，直接说明“视频数据是否还在传输”。
      sourceBufferBytes: (state.sourceBuffers ?? []).reduce((s, b) => s + (b.appendedBytes || 0), 0),
      sourceBufferAppendCalls: (state.sourceBuffers ?? []).reduce((s, b) => s + (b.appendCalls || 0), 0),
      network: state.network,
      mediaEvents: state.mediaEvents,
      elementErrors: state.elementErrors,
      blockedByNetwork: state.blockedByNetwork,
      liveStatusText: (document.querySelector(".live-status-tag, .live-status")?.textContent ?? "").trim().slice(0, 40),
    };
  }

  function report() {
    state.lastReportAt = Date.now();
    try {
      window.postMessage({ __vlbProbe: true, payload: snapshot() }, "*");
    } catch (error) {
      window.postMessage({ __vlbProbe: true, error: String(error?.message ?? error) }, "*");
    }
  }

  report();
  setInterval(report, 3000);
})();
