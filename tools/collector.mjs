// Verification collector: receives the extension's own ground-truth telemetry.
//
// Endpoints:
//   GET  /state   -> tells the extension's service worker whether to force blocking on/off
//   POST /report  -> a page-probe snapshot (media bytes, SourceBuffer, element state)
//   GET  /summary -> aggregated view of what was observed
//
// Usage: node tools/collector.mjs <port> <enabled|disabled>
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";

const port = Number(process.argv[2] || 8791);
const forceEnabled = String(process.argv[3] ?? "disabled") === "enabled";
const blockMode = process.argv[5] || "all";
const outFile = process.argv[4] || `tools/telemetry-${forceEnabled ? "on" : "off"}.json`;

const reports = [];
mkdirSync("tools", { recursive: true });

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.url.startsWith("/state")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ enabled: forceEnabled, blockMode, source: "collector" }));
    return;
  }

  if (req.url.startsWith("/report") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const snap = JSON.parse(body);
        reports.push(snap);
        if (reports.length % 10 === 1) {
          const r = snap.resources ?? {};
          console.log(
            `[report ${reports.length}] mediaReqs=${r.count} transfer=${r.transferTotal}B ` +
              `sbAppended=${(snap.sourceBuffers ?? []).reduce((s, b) => s + (b.appendedBytes || 0), 0)}B ` +
              `videos=${JSON.stringify((snap.videos ?? []).map((v) => `rs${v.readyState}/ns${v.networkState}/${v.videoWidth}x${v.videoHeight}/err${v.errorCode}`))}`,
          );
        }
        writeFileSync(outFile, JSON.stringify({ forceEnabled, reportCount: reports.length, reports }, null, 2));
      } catch (error) {
        console.log("bad report:", error.message);
      }
      res.writeHead(204).end();
    });
    return;
  }

  if (req.url.startsWith("/summary")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(summarise(), null, 2));
    return;
  }

  res.writeHead(404).end();
});

function summarise() {
  const mediaSnapshots = reports.map((r) => r.resources ?? {});
  const maxTransfer = Math.max(0, ...mediaSnapshots.map((r) => r.transferTotal ?? 0));
  const maxReqCount = Math.max(0, ...mediaSnapshots.map((r) => r.count ?? 0));
  const totalAppended = Math.max(
    0,
    ...reports.map((r) => (r.sourceBuffers ?? []).reduce((s, b) => s + (b.appendedBytes || 0), 0)),
  );
  const sourceBufferMimes = [
    ...new Set(reports.flatMap((r) => (r.sourceBuffers ?? []).map((b) => b.mime))),
  ];
  const mediaUrls = [
    ...new Set(reports.flatMap((r) => (r.network ?? []).map((n) => n.url?.split("?")[0]))),
  ].filter(Boolean);
  const videoStates = reports.flatMap((r) => r.videos ?? []);
  const elementErrors = reports.flatMap((r) => r.elementErrors ?? []);
  return {
    forceEnabled,
    blockMode,
    reportCount: reports.length,
    timeSpanMs: reports.length ? reports[reports.length - 1].at - reports[0].at : 0,
    maxMediaTransferBytes: maxTransfer,
    maxMediaRequestCount: maxReqCount,
    maxSourceBufferAppendedBytes: totalAppended,
    sourceBufferMimes,
    distinctMediaUrls: mediaUrls,
    lastVideoState: videoStates.at(-1) ?? null,
    anyVideoWithPicture: videoStates.some((v) => (v.videoWidth ?? 0) > 0),
    videoErrorCodes: [...new Set(videoStates.map((v) => v.errorCode).filter((c) => c !== null && c !== undefined))],
    elementErrors: elementErrors.slice(-10),
    byExtensionLast: mediaSnapshots.at(-1)?.byExtension ?? null,
  };
}

server.listen(port, "127.0.0.1", () => {
  console.log(`collector on http://127.0.0.1:${port}  forceEnabled=${forceEnabled}  -> ${outFile}`);
});

const shutdown = () => {
  writeFileSync(outFile, JSON.stringify({ forceEnabled, reportCount: reports.length, reports }, null, 2));
  console.log("\n== SUMMARY ==");
  console.log(JSON.stringify(summarise(), null, 2));
  console.log(`[saved] ${outFile}`);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setTimeout(shutdown, Number(process.env.COLLECTOR_LIFETIME_MS || 240000));
