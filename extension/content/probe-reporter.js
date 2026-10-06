/**
 * 验证用上报脚本（ISOLATED world）。
 *
 * 仅在设置了 window.__VLB_VERIFY__ 时才会把页面探针快照 POST 到本地收集器，
 * 用于实测阶段获取真实数据（视频字节数、SourceBuffer、媒体错误等）。
 * 正式使用插件时该地址无人监听，请求失败即可，不影响任何功能。
 */

(() => {
  const COLLECTOR = "http://127.0.0.1:8791/report";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__vlbProbe !== true || !data.payload) return;

    window.__VLB_LAST_SNAPSHOT__ = data.payload;

    try {
      void fetch(COLLECTOR, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data.payload),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  });
})();
