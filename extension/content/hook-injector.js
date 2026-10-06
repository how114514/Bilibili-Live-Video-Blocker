/**
 * Runs at document_start in the ISOLATED world.
 *
 * Its only job is to install scripts into the page's own JavaScript context,
 * because the objects we must observe or drive (fetch, XMLHttpRequest,
 * MediaSource) belong to the page, not to the extension.
 *
 * Order matters and is guaranteed two ways: `async = false` on dynamically
 * created scripts preserves document order, and we insert them in array order
 * in front of everything else so they run ahead of the player bundle.
 *
 * - page-probe.js     verification instrumentation; blocks nothing
 * - mpegts.min.js     the FLV/MSE player used by V2 audio-only playback
 * - audio-page.js     V2 audio-only player (main-world half)
 */

const VLB_INJECT_FILES = [
  "content/page-probe.js",
  "vendor/mpegts.min.js",
  "content/audio-page.js",
];

(() => {
  const parent = document.head || document.documentElement;
  if (!parent) return;
  const anchor = parent.firstChild;
  for (const file of VLB_INJECT_FILES) {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(file);
    script.async = false; // keep execution order, and keep them ahead of the player
    script.addEventListener("load", () => script.remove());
    parent.insertBefore(script, anchor);
  }
})();
