import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { convertToWebp, outputFilename, validateImageFormat, selectWebpFfmpeg } = require("../native-helper/image-converter.cjs");
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// 설치됐지만 실행이 깨졌거나 인코더가 없으면 건너뛰지 않고 실패해야 한다.
const ffmpegAvailable = spawnSync(process.env.TAB_DOWNLOADER_A_FFMPEG || "ffmpeg", ["-version"], { stdio: "ignore" }).error?.code !== "ENOENT";

test("WebP 출력 파일명은 순번을 유지하고 확장자만 통일한다", () => {
  assert.equal(outputFilename("0006.png", "webp"), "0006.webp");
  assert.equal(outputFilename("0001.webp", "webp"), "0001.webp");
  assert.equal(outputFilename("0002.jpg", "original"), "0002.jpg");
  assert.throws(() => validateImageFormat("jpeg"), /지원하지 않는 이미지 출력 형식/);
});

test("FFmpeg가 PNG 픽셀을 실제 WebP 파일로 변환한다", { skip: !ffmpegAvailable }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tab-downloader-webp-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.png");
  const destination = path.join(directory, "result.webp");
  fs.writeFileSync(source, tinyPng);
  await convertToWebp(selectWebpFfmpeg(process.env.TAB_DOWNLOADER_A_FFMPEG || "ffmpeg"), source, destination);
  const header = fs.readFileSync(destination).subarray(0, 12);
  assert.equal(header.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(header.subarray(8, 12).toString("ascii"), "WEBP");
});

test("설치 시 WebP 인코더를 확인하고 macOS full 빌드로 대체한다", (t) => {
  const full = "/test/homebrew/opt/ffmpeg-full/bin/ffmpeg";
  t.mock.method(childProcess, "execFileSync", (executable, args) => {
    if (executable === "brew") { assert.deepEqual(args, ["--prefix", "ffmpeg-full"]); return "/test/homebrew/opt/ffmpeg-full\n"; }
    return executable === "complete" || executable === full ? " V....D libwebp WebP\n V....D libwebp_anim animated WebP\n" : " V....D libwebp_anim animated WebP\n";
  });
  assert.equal(selectWebpFfmpeg("complete", "darwin"), "complete");
  assert.equal(selectWebpFfmpeg("incomplete", "darwin"), full);
  assert.throws(() => selectWebpFfmpeg("incomplete", "win32"), /libwebp와 libwebp_anim/);
});

test("GIF를 WebP로 변환해도 두 프레임 애니메이션을 유지한다", { skip: !ffmpegAvailable }, async (t) => {
  const executable = selectWebpFfmpeg(process.env.TAB_DOWNLOADER_A_FFMPEG || "ffmpeg");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tab-downloader-animated-webp-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source.gif");
  const destination = path.join(directory, "result.webp");
  const fixture = spawnSync(executable, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=8x8:rate=2:duration=1", "-loop", "0", source], { encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  await convertToWebp(executable, source, destination);
  const bytes = fs.readFileSync(destination);
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
  const chunks = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    chunks.push(bytes.subarray(offset, offset + 4).toString("ascii"));
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8 + size + size % 2;
  }
  assert.ok(chunks.includes("ANIM"));
  assert.equal(chunks.filter((chunk) => chunk === "ANMF").length, 2);
});
