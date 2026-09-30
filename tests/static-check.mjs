import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, "탭 다운로더 A");
assert.equal(manifest.version, "0.11.0");
assert.equal(JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8")).version, manifest.version);
assert.match(fs.readFileSync(new URL("sidepanel/sidepanel.html", root), "utf8"), new RegExp(`TD · ${manifest.version}`));
assert.equal(manifest.background.type, "module");
assert.ok(manifest.permissions.includes("alarms"));
assert.ok(manifest.host_permissions.includes("http://127.0.0.1:17385/*"));
assert.ok(manifest.host_permissions.includes("https://pbs.twimg.com/*"));
const transcriptScript = manifest.content_scripts.find((entry) => entry.matches.includes("https://www.youtube.com/*"));
assert.deepEqual(transcriptScript?.js, ["content/youtube-transcript.js", "content/youtube-pip.js"]);
assert.deepEqual(transcriptScript?.css, ["content/youtube-transcript.css", "content/youtube-pip.css"]);
assert.equal(transcriptScript?.run_at, "document_idle");
assert.ok(fs.existsSync(new URL("content/youtube-transcript.css", root)));
assert.ok(fs.existsSync(new URL("content/youtube-pip.css", root)));
for (const [size, iconPath] of Object.entries(manifest.icons)) {
  assert.ok(fs.existsSync(new URL(iconPath, root)), `${iconPath} missing`);
  const png = fs.readFileSync(new URL(iconPath, root));
  assert.equal(png.readUInt32BE(16), Number(size), `${iconPath} width mismatch`);
  assert.equal(png.readUInt32BE(20), Number(size), `${iconPath} height mismatch`);
  assert.equal(png[25], 6, `${iconPath} must use RGBA color`);
}
assert.ok(fs.existsSync(new URL("assets/icons/icon-source.svg", root)));
assert.ok(fs.existsSync(new URL("assets/icons/render-icons.ps1", root)));
const extensionId = [...crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
  .join("");
assert.equal(extensionId, "nccjgbgpcokjhaalfdbfmkomielehekd");

const serviceWorkerSource = fs.readFileSync(new URL("background/service-worker.js", root), "utf8");
assert.match(serviceWorkerSource, /resourceTypes:\s*\[[^\]]*"main_frame"[^\]]*"other"/s);
assert.match(serviceWorkerSource, /const DEFAULT_ROOT = "탭 다운로더 A"/);
assert.match(serviceWorkerSource, /LEGACY_ROOTS = new Set\(\["Tab Media Downloader"\]\)/);
assert.match(serviceWorkerSource, /onDeterminingFilename\.addListener\(\(item, suggest\)/);
assert.match(serviceWorkerSource, /item\.byExtensionId !== chrome\.runtime\.id/);
assert.match(serviceWorkerSource, /chrome\.downloads\.download\(\{\s*url: asset\.url,\s*filename,/s);
assert.match(serviceWorkerSource, /const JOB_QUEUE_KEY = "downloadJobQueue"/);
assert.match(serviceWorkerSource, /type === "GET_DOWNLOAD_QUEUE"/);

const sidepanelSource = fs.readFileSync(new URL("sidepanel/sidepanel.html", root), "utf8");
assert.match(sidepanelSource, /id="queueList"/);
assert.match(sidepanelSource, /id="queuePauseButton"/);

const windowsInstallerSource = fs.readFileSync(new URL("native-helper/install.ps1", root), "utf8");
assert.match(windowsInstallerSource, /TabDownloaderAMediaHelper/);
assert.match(windowsInstallerSource, /image-policy\.cjs/);
assert.match(windowsInstallerSource, /image-converter\.cjs/);
assert.match(windowsInstallerSource, /youtube-transcripts\.cjs/);
const macInstallerSource = fs.readFileSync(new URL("native-helper/install-macos.sh", root), "utf8");
assert.match(macInstallerSource, /com\.tabdownloadera\.media-helper/);
assert.match(macInstallerSource, /image-policy\.cjs/);
assert.match(macInstallerSource, /image-converter\.cjs/);
assert.match(macInstallerSource, /youtube-transcripts\.cjs/);

const catalog = JSON.parse(fs.readFileSync(new URL("catalog/engine-catalog.json", root), "utf8"));
assert.deepEqual(catalog.map((entry) => entry.id).sort(), ["twitter", "vimeo", "youtube"]);
assert.equal(new Set(catalog.map((entry) => entry.id)).size, catalog.length);
for (const entry of catalog) {
  assert.ok(entry.id && entry.name && Array.isArray(entry.hosts));
  assert.ok(["chrome", "native"].includes(entry.backend));
  if (entry.adapterScript) {
    assert.ok(fs.existsSync(new URL(entry.adapterScript, root)), `${entry.id} adapter script missing`);
  }
}

for (const relative of [
  "background/service-worker.js",
  "background/helper-client.js",
  "content/adapter-runtime.js",
  "content/analyzer.js",
  "content/adapters/embedded-video.js",
  "content/youtube-transcript.js",
  "content/youtube-pip.js",
  "content/adapters/youtube.js",
  "content/adapters/twitter.js",
  "shared/path-utils.js",
  "sidepanel/sidepanel.js",
  "native-helper/platform.cjs",
  "native-helper/image-policy.cjs",
  "native-helper/image-converter.cjs",
  "native-helper/youtube-transcripts.cjs",
  "native-helper/server.cjs",
  "native-helper/install-macos.sh",
  "native-helper/start-macos.sh",
]) {
  const filePath = fileURLToPath(new URL(relative, root));
  assert.ok(fs.existsSync(filePath), `${relative} missing`);
  if (relative.endsWith(".js") || relative.endsWith(".cjs")) {
    execFileSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
  }
}

console.log("manifest, catalog, JavaScript 정적 검사 통과");

assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:17385/*", "https://pbs.twimg.com/*"]);
for (const source of [windowsInstallerSource, macInstallerSource]) {
  assert.doesNotMatch(source, /TabDownloaderMediaHelper|com\.tabdownloader\.media-helper|17384/);
}
execFileSync('sh', ['-n', fileURLToPath(new URL('native-helper/install-macos.sh', root))]);
execFileSync('sh', ['-n', fileURLToPath(new URL('native-helper/start-macos.sh', root))]);
