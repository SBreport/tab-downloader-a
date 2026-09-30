import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const context = vm.createContext({ URL });
for (const file of ["content/adapter-runtime.js", "content/adapters/embedded-video.js"]) {
  vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context);
}
const adapter = context.TabMediaAdapters.registry[0];
const page = "https://ytory.com/view/?idx=166179015";
const doc = (urls) => ({
  title: "YTORY",
  querySelector: (selector) => selector === "h1" ? { textContent: "[2-1] 인트로의 모든 것" } : null,
  querySelectorAll: () => urls.map((src) => ({ getAttribute: (name) => name === "src" ? src : null })),
});

test("일반 페이지의 Vimeo iframe을 중복 제거하고 선택 후보와 Referer를 보존한다", () => {
  const result = adapter.extract(doc([
    "https://player.vimeo.com/video/1115098578?transparent=0",
    "https://player.vimeo.com/video/1115098578",
    "//player.vimeo.com/video/22222?h=abc123",
    "https://player.vimeo.com.evil.test/video/1115098578",
  ]), page);
  assert.equal(result.videoCandidates.length, 2);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].delivery.pageUrl, "https://player.vimeo.com/video/1115098578");
  assert.equal(result.assets[0].delivery.referer, page);
  assert.equal(result.title, "[2-1] 인트로의 모든 것");
  assert.match(result.videoCandidates[1].delivery.pageUrl, /h=abc123/);
  assert.throws(() => adapter.extract(doc([]), page), /영상을 찾지 못했습니다/);
  assert.equal(adapter.extract(doc([]), "https://vimeo.com/12345/abcdef").assets.length, 1);
});

const server = fs.readFileSync(new URL("../native-helper/server.cjs", import.meta.url), "utf8");
vm.runInContext(server.slice(server.indexOf("function validateMediaUrl"), server.indexOf("function validateChannelUrl")), context);
test("Helper는 Vimeo 영상 경로만 허용하고 Referer 헤더 삽입을 차단한다", () => {
  const media = context.validateMediaUrl("https://player.vimeo.com/video/1115098578?h=abc");
  assert.equal(media.type, "vimeo");
  assert.deepEqual(Array.from(context.mediaRefererArgs(media, page)), ["--referer", "https://ytory.com/"]);
  for (const url of ["http://player.vimeo.com/video/123", "https://player.vimeo.com.evil.test/video/123", "https://player.vimeo.com/config", "https://user:pass@player.vimeo.com/video/123", "https://player.vimeo.com:444/video/123", "https://127.0.0.1/video/123"]) {
    assert.throws(() => context.validateMediaUrl(url));
  }
  for (const referer of ["https://ytory.com/\r\nCookie:secret", "file:///etc/passwd", "https://user:pass@ytory.com/", 42]) {
    assert.throws(() => context.mediaRefererArgs(media, referer));
  }
});

test("실제 yt-dlp가 MP4 분리 음성을 포함하고 지정한 해상도 이하를 선택한다", (t) => {
  try { execFileSync("yt-dlp", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("yt-dlp 미설치"); return; }
  vm.runInContext(server.slice(server.indexOf("function formatForQuality"), server.indexOf("function resolveDownloadDirectory")), context);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tab-video-format-"));
  const file = path.join(directory, "info.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      id: "fixture", title: "Vimeo HLS", extractor: "vimeo", webpage_url: "https://vimeo.com/12345",
      formats: [
        { format_id: "audio", url: "https://example.com/audio.m3u8", ext: "mp4", vcodec: "none", acodec: null },
        ...[720, 1080].map((height) => ({ format_id: `video-${height}`, url: `https://example.com/${height}.m3u8`, ext: "mp4", vcodec: "avc1.64002A", acodec: "none", height })),
      ],
    }));
    for (const [quality, expected] of [["best", "video-1080+audio"], ["720", "video-720+audio"]]) {
      const selected = execFileSync("yt-dlp", ["--ignore-config", "--load-info-json", file, "--simulate", "--format", context.formatForQuality(quality), "--print", "format_id"], { encoding: "utf8" });
      assert.equal(selected.trim(), expected);
    }
    assert.throws(() => context.formatForQuality("720;echo bad"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
