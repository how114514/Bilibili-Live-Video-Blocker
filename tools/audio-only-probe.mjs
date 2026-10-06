// Does ANY playurl parameter combination expose an audio-only stream?
// This decides whether "keep Bilibili's own audio" is reachable at all.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ROOM = process.argv[2] || "5440";

const variants = [];
// protocol: 0=http_stream, 1=http_hls ; format: 0=flv,1=ts,2=fmp4
for (const protocol of ["0,1", "0", "1"]) {
  for (const format of ["0,1,2", "2", "1"]) {
    for (const ptype of ["8", "0", "2"]) {
      variants.push({ protocol, format, ptype });
    }
  }
}
// A few extra shapes seen in the wild / used by other clients.
variants.push({ protocol: "0,1", format: "0,1,2", ptype: "8", ptype2: true, extra: "&dolby=5&panorama=1" });

const seen = new Set();
const findings = [];

for (const v of variants) {
  const key = `${v.protocol}|${v.format}|${v.ptype}|${v.extra ?? ""}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const url =
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${ROOM}` +
    `&protocol=${v.protocol}&format=${v.format}&codec=0,1&qn=10000&platform=web&ptype=${v.ptype}` +
    `${v.extra ?? ""}`;

  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, referer: `https://live.bilibili.com/${ROOM}` },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    const playurl = json?.data?.playurl_info?.playurl;
    if (!playurl) {
      console.log(`protocol=${v.protocol} format=${v.format} ptype=${v.ptype} -> code=${json.code} ${json.message ?? ""}`);
      continue;
    }

    const combos = [];
    for (const s of playurl.stream ?? []) {
      for (const f of s.format ?? []) {
        for (const c of f.codec ?? []) {
          combos.push({
            proto: s.protocol_name,
            fmt: f.format_name,
            codec: c.codec_name,
            video: c.video_codecs?.base ?? null,
            audio: c.audio_codecs?.base ?? null,
            qn: c.current_qn,
            acceptQn: c.accept_qn,
            base: c.base_url?.split("?")[0],
          });
        }
      }
    }
    const audioOnly = combos.filter((c) => c.audio && !c.video);
    const videoOnly = combos.filter((c) => c.video && !c.audio);
    console.log(
      `protocol=${v.protocol} format=${v.format} ptype=${v.ptype}: combos=${combos.length} ` +
        `audioOnly=${audioOnly.length} videoOnly=${videoOnly.length}`,
    );
    for (const c of combos) {
      console.log(`    ${c.proto}/${c.fmt}/${c.codec} v=${c.video ?? "-"} a=${c.audio ?? "-"} qn=${c.qn} ${c.base}`);
    }
    findings.push({ variant: v, combos, audioOnly, videoOnly });
  } catch (err) {
    console.log(`protocol=${v.protocol} format=${v.format} ptype=${v.ptype} FAIL ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 600));
}

const anyAudioOnly = findings.some((f) => f.audioOnly.length > 0);
console.log("\n==================================================");
console.log(`任何参数组合出现纯音频流: ${anyAudioOnly ? "是" : "否"}`);
console.log(`共测试 ${findings.length} 个有效组合，全部 ${findings.reduce((s, f) => s + f.combos.length, 0)} 个流条目均为音视频复用或纯视频`);
