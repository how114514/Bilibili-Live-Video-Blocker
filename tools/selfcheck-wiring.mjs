// Consistency check: popup <-> popup.js <-> service worker message handlers,
// plus manifest references and a final report of the extension contents.
import { readFileSync } from "node:fs";

const html = readFileSync("extension/popup/popup.html", "utf8");
const js = readFileSync("extension/popup/popup.js", "utf8");
const sw = readFileSync("extension/background/service-worker.js", "utf8");
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

let problems = 0;
const fail = (m) => {
  problems++;
  console.log("  PROBLEM:", m);
};

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);

console.log("== popup DOM wiring ==");
console.log("  html ids:", [...htmlIds].join(", "));
for (const id of jsIds) if (!htmlIds.has(id)) fail(`popup.js 引用了不存在的元素 id: ${id}`);
console.log("  css linked:", /popup\.css/.test(html));
if (!/popup\.css/.test(html)) fail("popup.html 没有引入 popup.css");

console.log("\n== message protocol ==");
const used = [...new Set([...js.matchAll(/type:\s*"(\w+)"/g)].map((m) => m[1]))];
console.log("  popup 发送的消息类型:", used.join(", "));
for (const t of used) if (!sw.includes(`case "${t}"`)) fail(`service worker 缺少处理分支: ${t}`);
const handled = [...new Set([...sw.matchAll(/case "(\w+)"/g)].map((m) => m[1]))];
console.log("  service worker 处理:", handled.join(", "));
for (const t of handled) if (!used.includes(t)) console.log(`  (未被 popup 使用: ${t})`);

console.log("\n== manifest 引用 ==");
const referenced = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  manifest.action?.default_popup,
  ...(manifest.declarative_net_request?.rule_resources ?? []).map((r) => r.path),
].filter(Boolean);
for (const p of referenced) {
  try {
    readFileSync(`extension/${p}`);
    console.log("  ok:", p);
  } catch {
    fail(`manifest 引用了不存在的文件: ${p}`);
  }
}
const popupCss = manifest.action?.default_popup?.replace(/\.html$/, ".css");
if (popupCss) {
  try {
    readFileSync(`extension/${popupCss}`);
    console.log("  ok:", popupCss, "(由 html 引用)");
  } catch {
    fail(`popup 样式文件不存在: ${popupCss}`);
  }
}

console.log("\n== 权限自洽 ==");
const perms = manifest.permissions ?? [];
for (const needed of ["declarativeNetRequest", "storage"]) {
  if (!perms.includes(needed)) fail(`缺少权限: ${needed}`);
}
console.log("  permissions:", perms.join(", "));
console.log("  host_permissions:", (manifest.host_permissions ?? []).join(", "));

console.log("\n================================");
console.log(problems === 0 ? "一致性检查: 全部通过" : `一致性检查: ${problems} 个问题`);
process.exit(problems === 0 ? 0 : 1);
