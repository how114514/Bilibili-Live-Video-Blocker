// Probe the real Bilibili live stream-info API and dump the structure of what
// the player is actually offered. This is evidence gathering, not guessing.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const roomId = process.argv[2] || "5440";

const endpoints = [
  `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8&dolby=5&panorama=1`,
  `https://api.live.bilibili.com/xlive/web-room/v1/playUrl/playUrl?cid=${roomId}&platform=web&qn=10000&https_url_req=1&ptype=8`,
];

const out = [];
for (const url of endpoints) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, referer: `https://live.bilibili.com/${roomId}` },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    out.push({ url, status: res.status, json });
    console.log("=".repeat(100));
    console.log(`GET ${url}`);
    console.log(`status=${res.status} code=${json.code} message=${json.message ?? json.msg}`);
    console.log("=".repeat(100));
    console.log(JSON.stringify(json, null, 2).slice(0, 12000));
  } catch (err) {
    console.log(`FAIL ${url}: ${err.message}`);
  }
}

import { writeFileSync } from "node:fs";
writeFileSync("tools/streaminfo-raw.json", JSON.stringify(out, null, 2), "utf8");
console.log("\n[saved] tools/streaminfo-raw.json");
