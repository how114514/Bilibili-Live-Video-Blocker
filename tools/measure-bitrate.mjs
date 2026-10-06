// Measure the REAL average bitrate of a live stream by streaming it briefly.
// This gives an evidence-based number for the "estimated saved traffic" figure.
import { readFileSync, writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ROOM = process.argv[2] || "5440";
const SECONDS = Number(process.argv[3] || 12);

// Re-fetch fresh stream info (tokens expire).
const api = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${ROOM}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8&dolby=5&panorama=1`;
const info = (await (await fetch(api, { headers: { "user-agent": UA, referer: `https://live.bilibili.com/${ROOM}` } })).json())
  .data.playurl_info.playurl;

function findUrl(formatName, codecName) {
  for (const s of info.stream) {
    for (const f of s.format ?? []) {
      if (f.format_name !== formatName) continue;
      for (const c of f.codec ?? []) {
        if (c.codec_name !== codecName) continue;
        const u = c.url_info[0];
        return { url: u.host + c.base_url + u.extra, c };
      }
    }
  }
  return null;
}

async function measure(label, target, seconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  let bytes = 0;
  let firstByteAt = 0;
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      headers: { "user-agent": UA, referer: `https://live.bilibili.com/${ROOM}` },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstByteAt) firstByteAt = Date.now();
      bytes += value.byteLength;
    }
  } catch (err) {
    if (err.name !== "AbortError" && err.code !== "ABORT_ERR") {
      console.log(`  ${label} error: ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
  const elapsed = (Date.now() - started) / 1000;
  const bps = (bytes * 8) / elapsed;
  console.log(
    `  ${label}: ${bytes} bytes in ${elapsed.toFixed(2)}s -> ${(bps / 1e6).toFixed(3)} Mbps ` +
      `(${(bytes / elapsed / 1024 / 1024).toFixed(3)} MB/s)`,
  );
  return { label, bytes, elapsed, bps, mbPerSec: bytes / elapsed / 1024 / 1024 };
}

const results = [];
for (const [fmt, codec] of [
  ["flv", "avc"],
  ["fmp4", "avc"],
  ["ts", "avc"],
]) {
  const target = findUrl(fmt, codec);
  if (!target) continue;
  console.log(`\n[${fmt}/${codec}] ${target.c.base_url}`);
  const media = target.c.media_info;
  if (media) console.log(`  api-reported: ${media.width}x${media.height}, realtime_avg_bw=${media.realtime_avg_bw}`);
  results.push(await measure(`${fmt}/${codec}`, target, SECONDS));
  await new Promise((r) => setTimeout(r, 1200));
}

const flv = results.find((r) => r.label.startsWith("flv"));
const summary = {
  measuredAt: new Date().toISOString(),
  room: ROOM,
  results,
  recommendedBitsPerSecond: flv ? Math.round(flv.bps) : null,
  recommendedMegaBytesPerSecond: flv ? Number(flv.mbPerSec.toFixed(4)) : null,
};
writeFileSync("tools/bitrate-measurement.json", JSON.stringify(summary, null, 2), "utf8");
console.log("\n== summary ==");
console.log(JSON.stringify(summary, null, 2));
