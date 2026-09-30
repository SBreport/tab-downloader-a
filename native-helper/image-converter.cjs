"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const OUTPUT_FORMATS = new Set(["original", "webp"]);

// 설치와 검사에서 같은 실행 파일을 선택한다. 시스템 FFmpeg 링크는 변경하지 않는다.
function selectWebpFfmpeg(preferred = "ffmpeg", platform = process.platform) {
  const supportsWebp = (executable) => {
    try {
      const encoders = childProcess.execFileSync(executable, ["-hide_banner", "-encoders"], {
        encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      return /\blibwebp\s/.test(encoders) && /\blibwebp_anim\s/.test(encoders);
    } catch { return false; }
  };
  if (preferred && supportsWebp(preferred)) return preferred;
  if (platform === "darwin") {
    let prefix;
    try {
      prefix = childProcess.execFileSync("brew", ["--prefix", "ffmpeg-full"], {
        encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch { /* Homebrew가 없으면 아래 설치 안내를 반환한다. */ }
    if (prefix && path.isAbsolute(prefix)) {
      const full = path.join(prefix, "bin", "ffmpeg");
      if (supportsWebp(full)) return full;
    }
  }
  const action = platform === "darwin"
    ? "brew install ffmpeg-full 실행 후 Helper를 다시 설치해 주세요."
    : "libwebp와 libwebp_anim이 포함된 FFmpeg를 설치한 뒤 Helper를 다시 설치해 주세요.";
  throw new Error(`FFmpeg에 정적·애니메이션 WebP 인코더가 필요합니다. ${action}`);
}

function validateImageFormat(value) {
  const format = String(value || "original").toLowerCase();
  if (!OUTPUT_FORMATS.has(format)) throw new Error("지원하지 않는 이미지 출력 형식입니다.");
  return format;
}

function outputFilename(filename, format) {
  const value = String(filename || "");
  return validateImageFormat(format) === "webp"
    ? `${path.basename(value, path.extname(value))}.webp`
    : value;
}

function convertToWebp(ffmpegPath, source, destination, signal) {
  const animated = path.extname(source).toLowerCase() === ".gif";
  const codec = animated ? "libwebp_anim" : "libwebp";
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", source,
    "-map_metadata", "-1",
    "-c:v", codec,
    "-lossless", "1",
    "-compression_level", "4",
    ...(animated ? ["-loop", "0"] : ["-frames:v", "1"]),
    "-f", "webp",
    destination,
  ];
  return new Promise((resolve, reject) => {
    childProcess.execFile(ffmpegPath, args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true,
      signal,
    }, (error, _stdout, stderr) => {
      if (error) {
        const detail = /Unknown encoder|Encoder not found/i.test(String(stderr))
          ? "FFmpeg에 WebP 인코더가 없습니다. WebP 지원 FFmpeg 설치 후 Helper를 다시 설치해 주세요."
          : String(stderr || error.message).trim().split(/\r?\n/).filter(Boolean).at(-1);
        reject(new Error(detail || "WebP 변환에 실패했습니다."));
      } else if (!fs.existsSync(destination)) {
        reject(new Error("WebP 변환 결과 파일이 생성되지 않았습니다."));
      } else {
        resolve(destination);
      }
    });
  });
}

module.exports = { convertToWebp, outputFilename, validateImageFormat, selectWebpFfmpeg };
