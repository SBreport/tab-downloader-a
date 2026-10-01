"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { convertToWebp, outputFilename, validateImageFormat } = require("./image-converter.cjs");
const { imagePolicy, validateImageAssets } = require("./image-policy.cjs");
const { folderOpenCommand, folderOpenSpawnOptions } = require("./platform.cjs");
const {
  MAX_PLAYLIST_VIDEOS,
  buildTranscriptText,
  parseSubtitle,
  selectSubtitle,
  validatePlaylistUrl,
  validateSubtitleUrl,
} = require("./youtube-transcripts.cjs");

const configPath = process.argv[2];
if (!configPath || !fs.existsSync(configPath)) throw new Error("helper-config.json이 없습니다.");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(config.port) || 17385;
const allowedOrigin = `chrome-extension://${config.extensionId}`;
const jobs = new Map();
const MAX_IMAGE_BYTES = 250 * 1024 * 1024;

for (const key of ["ytDlpPath", "ffmpegPath"]) {
  if (!config[key] || !fs.existsSync(config[key])) throw new Error(`${key} 실행 파일이 없습니다.`);
}

function version(executable, argument) {
  try {
    return childProcess.execFileSync(executable, [argument], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }).split(/\r?\n/)[0].trim();
  } catch {
    return "unavailable";
  }
}

function send(response, status, data, origin) {
  const body = Buffer.from(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), "utf8");
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin || allowedOrigin,
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("요청이 너무 큽니다."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("JSON 요청 형식이 올바르지 않습니다.")); }
    });
    request.on("error", reject);
  });
}

function validateMediaUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("HTTPS 미디어 URL만 허용됩니다.");
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    return { url: url.href, type: "youtube" };
  }
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
    if (!/^\/[^/]+\/status\/\d+/.test(url.pathname)) throw new Error("X 개별 게시물 URL만 허용됩니다.");
    return { url: url.href, type: "twitter" };
  }
  if (!url.username && !url.password && !url.port && (
    (host === "player.vimeo.com" && /^\/video\/\d+\/?$/.test(url.pathname)) ||
    (["vimeo.com", "www.vimeo.com"].includes(host) && /^\/\d+(?:\/[a-zA-Z0-9]+)?\/?$/.test(url.pathname))
  )) return { url: url.href, type: "vimeo" };
  throw new Error("허용되지 않은 미디어 사이트입니다.");
}

function mediaRefererArgs(media, raw) {
  if (raw === undefined || raw === "") return [];
  if (media.type !== "vimeo" || typeof raw !== "string" || raw.length > 8192 || /[\r\n\0]/.test(raw)) {
    throw new Error("허용되지 않은 영상 Referer입니다.");
  }
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("영상 Referer는 웹페이지 주소여야 합니다.");
  }
  // 출처만 전달해 삽입 페이지의 검색어·인증 토큰이 외부로 전달되지 않게 한다.
  return ["--referer", `${url.origin}/`];
}

function validateChannelUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("HTTPS 채널 URL만 허용됩니다.");
  if (host !== "youtube.com" && host !== "www.youtube.com" && host !== "m.youtube.com") {
    throw new Error("허용되지 않은 채널 사이트입니다.");
  }
  const isChannelPath = /^\/@[^/]+(\/(videos|shorts))?\/?$/.test(url.pathname)
    || /^\/channel\/[^/]+(\/(videos|shorts))?\/?$/.test(url.pathname)
    || /^\/c\/[^/]+(\/(videos|shorts))?\/?$/.test(url.pathname)
    || /^\/user\/[^/]+(\/(videos|shorts))?\/?$/.test(url.pathname);
  if (!isChannelPath) throw new Error("채널 URL 형식이 올바르지 않습니다.");
  return url;
}

function channelTabUrls(raw) {
  const url = validateChannelUrl(raw);
  const base = url.pathname.replace(/\/+$/, "").replace(/\/(videos|shorts)$/, "");
  return {
    videos: `${url.origin}${base}/videos`,
    shorts: `${url.origin}${base}/shorts`,
  };
}

function validateImageJob(input) {
  if (!input.jobId || jobs.has(input.jobId)) throw new Error("jobId가 없거나 이미 사용 중입니다.");
  return {
    assets: validateImageAssets(input.type, input.assets),
    imageFormat: validateImageFormat(input.imageFormat),
  };
}

function safeComponent(value, fallback) {
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  let clean = String(value || fallback).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/g, "");
  if (!clean || clean === "." || clean === "..") clean = fallback;
  if (reserved.test(clean)) clean = `_${clean}`;
  return clean.slice(0, 100).replace(/[. ]+$/g, "") || fallback;
}

function formatForQuality(quality) {
  // QuickTime 등 macOS 기본 플레이어 호환을 위해 H.264(avc1)+AAC(mp4a)를 우선한다.
  // 없으면 mp4/m4a, 그다음 아무 포맷으로 폴백해 다운로드 자체는 실패하지 않게 한다.
  // (대가: YouTube의 avc1은 대개 1080p까지 — 그 이상은 av1/vp9로 폴백돼 QuickTime 비호환일 수 있음.)
  if (!quality || quality === "best") {
    return "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best";
  }
  const height = Number(quality);
  if (!Number.isInteger(height) || height < 144 || height > 4320) throw new Error("허용되지 않은 화질입니다.");
  return `bestvideo[vcodec^=avc1][height<=${height}]+bestaudio[acodec^=mp4a]/bestvideo[ext=mp4][height<=${height}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${height}]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

function resolveDownloadDirectory(input) {
  const downloads = path.resolve(os.homedir(), "Downloads");
  let target;
  if (input.outputDirectory) {
    target = path.resolve(String(input.outputDirectory));
  } else if (input.relativeDirectory) {
    const parts = String(input.relativeDirectory).replace(/\\/g, "/").split("/").filter(Boolean);
    if (!parts.length || parts.some((part) => part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part))) {
      throw new Error("다운로드 상대 경로가 올바르지 않습니다.");
    }
    target = path.resolve(downloads, ...parts);
  } else {
    throw new Error("열 다운로드 폴더 정보가 없습니다.");
  }
  if (target !== downloads && !target.startsWith(`${downloads}${path.sep}`)) {
    throw new Error("Downloads 밖의 폴더는 열 수 없습니다.");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error("다운로드 폴더가 아직 생성되지 않았습니다.");
  }
  return target;
}

function openDownloadDirectory(input) {
  const target = resolveDownloadDirectory(input);
  const command = folderOpenCommand();
  return new Promise((resolve, reject) => {
    const processHandle = childProcess.spawn(command, [target], folderOpenSpawnOptions());
    processHandle.once("spawn", () => {
      processHandle.unref();
      resolve({ path: target });
    });
    processHandle.once("error", reject);
  });
}

function uniqueDestination(directory, filename) {
  const original = path.join(directory, filename);
  if (!fs.existsSync(original)) return original;
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  for (let number = 1; number <= 9999; number += 1) {
    const candidate = path.join(directory, `${stem} (${number})${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("중복되지 않는 파일명을 만들 수 없습니다.");
}

async function downloadImageAsset(job, asset) {
  const policy = imagePolicy(job.type);
  const response = await fetch(asset.url, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: asset.referer,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
    },
    redirect: "follow",
    signal: job.controller.signal,
  });
  if (!response.ok) throw new Error(`${policy.label} 원본 서버 HTTP ${response.status}`);
  policy.validate(response.url, asset.filename, asset.referer);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!policy.contentType(contentType)) throw new Error(`허용되지 않은 이미지 응답입니다: ${contentType || "unknown"}`);
  const declaredSize = Number(response.headers.get("content-length")) || 0;
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error("이미지 파일이 250MB 제한을 초과합니다.");
  if (!response.body) throw new Error(`${policy.label} 이미지 응답 본문이 없습니다.`);

  const requestedFilename = outputFilename(asset.filename, job.imageFormat);
  const assetDirectory = asset.folder
    ? path.join(job.outputDirectory, safeComponent(asset.folder, "폴더"))
    : job.outputDirectory;
  fs.mkdirSync(assetDirectory, { recursive: true });
  const destination = uniqueDestination(assetDirectory, requestedFilename);
  const shouldConvert = job.imageFormat === "webp" && path.extname(asset.filename).toLowerCase() !== ".webp";
  const sourceTemporary = shouldConvert
    ? `${destination}.source-${job.jobId}${path.extname(asset.filename).toLowerCase()}`
    : `${destination}.part-${job.jobId}`;
  const convertedTemporary = `${destination}.part-${job.jobId}.webp`;
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > MAX_IMAGE_BYTES ? new Error("이미지 파일이 250MB 제한을 초과합니다.") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(sourceTemporary, { flags: "wx" }));
    if (shouldConvert) {
      await convertToWebp(config.ffmpegPath, sourceTemporary, convertedTemporary, job.controller.signal);
      if (fs.statSync(convertedTemporary).size > MAX_IMAGE_BYTES) {
        throw new Error("변환된 WebP 파일이 250MB 제한을 초과합니다.");
      }
      fs.renameSync(convertedTemporary, destination);
      fs.rmSync(sourceTemporary, { force: true });
    } else {
      fs.renameSync(sourceTemporary, destination);
    }
    return destination;
  } catch (error) {
    for (const temporary of [sourceTemporary, convertedTemporary]) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* 이 작업이 만든 임시 파일만 정리합니다. */ }
    }
    throw error;
  }
}

async function runImageDownload(job, assets) {
  const policy = imagePolicy(job.type);
  job.status = "downloading";
  for (let index = 0; index < assets.length; index += 1) {
    if (job.cancelRequested) break;
    job.currentItem = index + 1;
    job.currentFolder = assets[index].folder || "";
    try {
      job.filename = await downloadImageAsset(job, assets[index]);
      job.completedFiles += 1;
    } catch (error) {
      if (job.cancelRequested || error?.name === "AbortError") break;
      job.failedFiles += 1;
      const folder = assets[index].folder ? ` · ${assets[index].folder}` : "";
      job.errors.push(`#${index + 1}${folder}: ${error?.message || String(error)}`);
      if (job.errors.length > 20) job.errors.shift();
    }
    job.percent = Math.round((job.completedFiles + job.failedFiles) / assets.length * 100);
    job.updatedAt = new Date().toISOString();
    if (!job.cancelRequested && policy.delayMs && index + 1 < assets.length) {
      await new Promise((resolve) => setTimeout(resolve, policy.delayMs));
    }
  }
  if (job.cancelRequested) {
    job.status = "canceled";
  } else if (job.failedFiles) {
    job.status = "finished_with_errors";
    job.error = job.errors.at(-1) || "일부 이미지 다운로드 실패";
  } else {
    job.status = "completed";
    job.percent = 100;
  }
  job.controller = null;
  job.updatedAt = new Date().toISOString();
}

function startImageDownload(input) {
  const { assets, imageFormat } = validateImageJob(input);
  const policy = imagePolicy(input.type);
  const outputDirectory = path.join(
    os.homedir(),
    "Downloads",
    safeComponent(input.root, "탭 다운로더 A"),
    input.type,
    safeComponent(input.title, policy.label),
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const job = {
    jobId: input.jobId,
    type: input.type,
    status: "starting",
    percent: 0,
    mediaCount: assets.length,
    currentItem: 0,
    completedFiles: 0,
    failedFiles: 0,
    imageFormat,
    outputDirectory,
    filename: "",
    error: "",
    errors: [],
    controller: new AbortController(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  runImageDownload(job, assets).catch((error) => {
    job.controller = null;
    job.status = job.cancelRequested ? "canceled" : "failed";
    job.error = job.cancelRequested ? "" : error?.message || String(error);
    job.updatedAt = new Date().toISOString();
  });
  return job;
}

function capture(executable, args, timeout = 60000, signal) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(executable, args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      signal,
      timeout,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim().split(/\r?\n/).filter(Boolean).at(-1);
        reject(new Error(detail || "미디어 분석 실패"));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function probe(url, referer) {
  const media = validateMediaUrl(url);
  const output = await capture(config.ytDlpPath, [
    "--ignore-config", ...mediaRefererArgs(media, referer),
    "--dump-single-json", "--no-playlist", "--skip-download", "--no-warnings",
    "--socket-timeout", "20", "--retries", "2", "--extractor-retries", "2",
    media.url,
  ]);
  const info = JSON.parse(output);
  const leafEntries = (value) => Array.isArray(value?.entries) && value.entries.length
    ? value.entries.filter(Boolean).flatMap(leafEntries)
    : [value];
  const entries = leafEntries(info);
  const formats = entries.flatMap((entry) => entry?.formats || []);
  const heights = [...new Set(formats
    .filter((format) => format.vcodec && format.vcodec !== "none" && Number(format.height) > 0)
    .map((format) => Number(format.height)))]
    .sort((a, b) => b - a);
  return {
    type: media.type,
    title: info.title || (media.type === "twitter" ? "X Post" : "YouTube"),
    videoId: info.id,
    mediaCount: entries.length,
    duration: entries.reduce((sum, entry) => sum + (Number(entry?.duration) || 0), 0),
    thumbnail: info.thumbnail || entries.find((entry) => entry?.thumbnail)?.thumbnail,
    qualities: [
      { value: "best", label: "최고 화질 · 영상당 MP4 1개" },
      ...heights.map((height) => ({ value: String(height), label: `${height}p 이하 · 영상당 1개` })),
    ],
  };
}

async function fetchChannelTab(tabUrl, limit, offset) {
  try {
    const output = await capture(config.ytDlpPath, [
      "--flat-playlist", "--dump-single-json", "--no-warnings",
      "--playlist-start", String(offset + 1), "--playlist-end", String(offset + limit),
      "--socket-timeout", "20", "--extractor-retries", "2",
      tabUrl,
    ], 60000);
    const info = JSON.parse(output);
    const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
    return {
      name: String(info.channel || info.uploader || "").trim(),
      videos: entries.map((entry) => ({
        id: entry.id,
        title: entry.title || "",
        duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
        url: `https://www.youtube.com/watch?v=${entry.id}`,
      })),
    };
  } catch {
    return { name: "", videos: [] };
  }
}

async function probeChannel(input) {
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
  const offset = Math.max(0, Number(input.offset) || 0);
  const tabs = channelTabUrls(input.url);
  const [videosTab, shortsTab] = await Promise.all([
    fetchChannelTab(tabs.videos, limit, offset),
    fetchChannelTab(tabs.shorts, limit, offset),
  ]);
  return {
    channelName: videosTab.name || shortsTab.name || "",
    longform: videosTab.videos,
    shorts: shortsTab.videos,
    hasMore: { longform: videosTab.videos.length === limit, shorts: shortsTab.videos.length === limit },
  };
}

async function probePlaylist(rawUrl, signal) {
  const url = validatePlaylistUrl(rawUrl);
  const output = await capture(config.ytDlpPath, [
    "--flat-playlist", "--dump-single-json", "--ignore-errors", "--no-warnings",
    "--playlist-end", String(MAX_PLAYLIST_VIDEOS + 1),
    "--socket-timeout", "20", "--retries", "2", "--extractor-retries", "2",
    url,
  ], 120000, signal);
  const info = JSON.parse(output);
  const entries = (Array.isArray(info.entries) ? info.entries : [])
    .filter((entry) => entry?.id && /^[A-Za-z0-9_-]{6,20}$/.test(entry.id))
    .map((entry) => ({
      id: entry.id,
      title: entry.title || "제목 없음",
      duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
    }));
  if (!entries.length) throw new Error("재생목록에서 공개 영상을 찾지 못했습니다.");
  if (entries.length > MAX_PLAYLIST_VIDEOS) {
    throw new Error(`재생목록은 최대 ${MAX_PLAYLIST_VIDEOS}개 영상까지 지원합니다.`);
  }
  return {
    url,
    title: String(info.title || "YouTube 재생목록").trim(),
    channel: String(info.channel || info.uploader || "").trim(),
    entries,
    count: entries.length,
  };
}

async function fetchVideoTranscript(video, signal) {
  const output = await capture(config.ytDlpPath, [
    "--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings",
    "--socket-timeout", "20", "--retries", "2", "--extractor-retries", "2",
    video.url,
  ], 60000, signal);
  const info = JSON.parse(output);
  const track = selectSubtitle(info);
  if (!track) throw new Error("사용 가능한 자막이 없습니다.");
  const response = await fetch(validateSubtitleUrl(track.url), { signal });
  if (!response.ok) throw new Error(`자막 서버 HTTP ${response.status}`);
  const segments = parseSubtitle(track.ext, await response.text());
  if (!segments.length) throw new Error("자막 내용이 비어 있습니다.");
  return { info, segments };
}

async function runTranscriptPlaylist(job, playlistUrl) {
  try {
    const playlist = await probePlaylist(playlistUrl, job.controller.signal);
    job.mediaCount = playlist.count;
    for (let index = 0; index < playlist.entries.length; index += 1) {
      if (job.cancelRequested) break;
      const video = playlist.entries[index];
      job.status = "downloading";
      job.currentItem = index + 1;
      job.updatedAt = new Date().toISOString();
      try {
        const { info, segments } = await fetchVideoTranscript(video, job.controller.signal);
        const prefix = String(index + 1).padStart(Math.max(3, String(playlist.count).length), "0");
        const filename = `${prefix} ${safeComponent(info.title || video.title, "영상")}.txt`;
        const destination = uniqueDestination(job.outputDirectory, filename);
        fs.writeFileSync(destination, buildTranscriptText(info, segments), "utf8");
        job.filename = destination;
        job.completedFiles += 1;
      } catch (error) {
        if (job.cancelRequested || error?.name === "AbortError") break;
        job.failedFiles += 1;
        job.errors.push(`#${index + 1} ${video.title}: ${error?.message || String(error)}`);
        if (job.errors.length > 20) job.errors.shift();
      }
      job.percent = Math.round((job.completedFiles + job.failedFiles) / playlist.count * 100);
      job.updatedAt = new Date().toISOString();
      if (!job.cancelRequested && index + 1 < playlist.entries.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (job.cancelRequested) {
      job.status = "canceled";
    } else if (job.failedFiles) {
      job.status = "finished_with_errors";
      job.error = job.errors.at(-1) || "일부 스크립트 다운로드 실패";
    } else {
      job.status = "completed";
      job.percent = 100;
    }
  } catch (error) {
    job.status = job.cancelRequested || error?.name === "AbortError" ? "canceled" : "failed";
    job.error = job.status === "failed" ? error?.message || String(error) : "";
  } finally {
    job.controller = null;
    job.updatedAt = new Date().toISOString();
  }
}

function startTranscriptPlaylist(input) {
  if (!input.jobId || jobs.has(input.jobId)) throw new Error("jobId가 없거나 이미 사용 중입니다.");
  const playlistUrl = validatePlaylistUrl(input.url);
  const outputDirectory = path.join(
    os.homedir(), "Downloads", safeComponent(input.root, "탭 다운로더 A"),
    "youtube-playlist", safeComponent(input.title, "YouTube 재생목록"),
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const job = {
    jobId: input.jobId,
    type: "youtube_playlist_transcript",
    status: "starting",
    percent: 0,
    mediaCount: Math.min(MAX_PLAYLIST_VIDEOS, Math.max(1, Number(input.mediaCount) || 1)),
    currentItem: 0,
    completedFiles: 0,
    failedFiles: 0,
    outputDirectory,
    filename: "",
    error: "",
    errors: [],
    controller: new AbortController(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  runTranscriptPlaylist(job, playlistUrl);
  return job;
}

function startDownload(input) {
  if (!input.jobId || jobs.has(input.jobId)) throw new Error("jobId가 없거나 이미 사용 중입니다.");
  const media = validateMediaUrl(input.url);
  const refererArgs = mediaRefererArgs(media, input.referer);
  const quality = input.quality || "best";
  const format = formatForQuality(quality);
  // folders가 오면 채널 묶음 경로(youtube/채널명/shorts)로 파일을 직접 저장하고,
  // 없으면 기존처럼 제목 폴더(youtube/제목/…)를 만든다.
  const extraFolders = Array.isArray(input.folders)
    ? input.folders.map((folder) => safeComponent(folder, "")).filter(Boolean)
    : [];
  const outputDirectory = path.join(
    os.homedir(),
    "Downloads",
    safeComponent(input.root, "탭 다운로더 A"),
    media.type,
    ...(extraFolders.length
      ? extraFolders
      : [safeComponent(input.title, media.type === "twitter" ? "X Post" : "YouTube")]),
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const job = {
    jobId: input.jobId,
    status: "starting",
    percent: 0,
    quality,
    mediaCount: Math.max(1, Number(input.mediaCount) || 1),
    currentItem: 0,
    completedFiles: 0,
    outputDirectory,
    filename: "",
    error: "",
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);

  const args = [
    "--ignore-config", ...refererArgs,
    "--newline", "--progress", "--no-color", "--no-playlist", "--no-keep-video", "--no-keep-fragments",
    "--windows-filenames", "--trim-filenames", "180",
    "--ffmpeg-location", path.dirname(config.ffmpegPath),
    "--paths", outputDirectory,
    // 채널 묶음 다운로드(folders 존재)는 업로드일 순 정렬용 [YYMMDD]제목-채널명 형식,
    // 개별 영상은 기존 "제목 [id]" 형식을 유지한다.
    "--output", media.type === "twitter"
      ? "%(autonumber)04d [%(id)s].%(ext)s"
      : extraFolders.length
        ? "[%(upload_date>%y%m%d)s]%(title).150B-%(channel)s.%(ext)s"
        : "%(title).180B [%(id)s].%(ext)s",
    "--format", format,
    "--merge-output-format", "mp4",
    "--progress-template", "download:__TAB_DOWNLOADER_PROGRESS__%(playlist_index)s/%(playlist_count)s|%(progress._percent_str)s",
    "--print", "after_move:__TAB_DOWNLOADER_FILE__%(filepath)s",
    media.url,
  ];
  const process = childProcess.spawn(config.ytDlpPath, args, { windowsHide: true });
  job.process = process;
  const errors = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const consume = (text, isError) => {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const progress = line.match(/__TAB_DOWNLOADER_PROGRESS__(\d+|NA)\/(\d+|NA)\|\s*([0-9]+(?:\.[0-9]+)?)%/);
      if (progress) {
        job.status = "downloading";
        const item = Number(progress[1]);
        const count = Number(progress[2]);
        const itemPercent = Number(progress[3]);
        if (Number.isFinite(item) && Number.isFinite(count) && count > 0) {
          job.currentItem = item;
          job.mediaCount = count;
          job.percent = Math.min(98, ((item - 1) + itemPercent / 100) / count * 100);
        } else {
          job.currentItem = 1;
          job.percent = Math.min(98, itemPercent);
        }
      } else if (line.startsWith("__TAB_DOWNLOADER_FILE__")) {
        job.status = "finalizing";
        job.percent = 99;
        job.filename = line.slice("__TAB_DOWNLOADER_FILE__".length);
        job.completedFiles += 1;
      } else if (/Merging formats/i.test(line)) {
        job.status = "merging";
        job.percent = 99;
      } else if (isError && /(ERROR|WARNING)/i.test(line)) {
        errors.push(line.trim());
        if (errors.length > 20) errors.shift();
      }
      job.updatedAt = new Date().toISOString();
    }
  };
  process.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    consume(lines.join("\n"), false);
  });
  process.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop();
    consume(lines.join("\n"), true);
  });
  process.on("error", (error) => {
    job.status = job.cancelRequested ? "canceled" : "failed";
    job.error = job.cancelRequested ? "" : error.message;
    job.process = null;
  });
  process.on("exit", (code) => {
    consume(stdoutBuffer, false);
    consume(stderrBuffer, true);
    job.process = null;
    job.updatedAt = new Date().toISOString();
    if (job.cancelRequested) {
      job.status = "canceled";
      job.error = "";
    } else if (code === 0) {
      job.status = "completed";
      job.percent = 100;
    } else {
      job.status = "failed";
      job.error = errors.at(-1) || `yt-dlp 종료 코드 ${code}`;
    }
  });
  return job;
}

function publicJob(job) {
  if (!job) return null;
  const { process: _process, controller: _controller, cancelRequested: _cancelRequested, ...value } = job;
  return value;
}

function terminateProcessTree(processHandle) {
  if (!processHandle?.pid) return Promise.resolve();
  if (process.platform !== "win32") {
    processHandle.kill("SIGTERM");
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    childProcess.execFile("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }, () => resolve());
  });
}

async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("작업을 찾을 수 없습니다.");
  if (!["completed", "failed", "finished_with_errors", "canceled"].includes(job.status)) {
    job.cancelRequested = true;
    if (job.controller) job.controller.abort();
    await terminateProcessTree(job.process);
    job.status = "canceled";
    job.error = "";
    job.updatedAt = new Date().toISOString();
  }
  return publicJob(job);
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (origin && origin !== allowedOrigin) return send(response, 403, "허용되지 않은 확장프로그램입니다.", allowedOrigin);
  if (request.method === "OPTIONS") return send(response, 200, {}, origin);
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/hello") {
      return send(response, 200, {
        name: "탭 다운로더 A Media Helper",
        version: "0.12.0",
        platform: process.platform,
        ytDlp: version(config.ytDlpPath, "--version"),
        ffmpeg: version(config.ffmpegPath, "-version"),
      }, origin);
    }
    if (request.method === "POST" && url.pathname === "/probe") {
      const input = await readJson(request);
      return send(response, 200, await probe(input.url, input.referer), origin);
    }
    if (request.method === "POST" && url.pathname === "/probe-channel") {
      const input = await readJson(request);
      return send(response, 200, await probeChannel(input), origin);
    }
    if (request.method === "POST" && url.pathname === "/probe-playlist") {
      const input = await readJson(request);
      return send(response, 200, await probePlaylist(input.url), origin);
    }
    if (request.method === "POST" && url.pathname === "/start") {
      const input = await readJson(request);
      return send(response, 200, publicJob(startDownload(input)), origin);
    }
    if (request.method === "POST" && url.pathname === "/start-images") {
      const input = await readJson(request);
      return send(response, 200, publicJob(startImageDownload(input)), origin);
    }
    if (request.method === "POST" && url.pathname === "/start-transcripts") {
      const input = await readJson(request);
      return send(response, 200, publicJob(startTranscriptPlaylist(input)), origin);
    }
    if (request.method === "POST" && url.pathname === "/open-folder") {
      const input = await readJson(request);
      return send(response, 200, await openDownloadDirectory(input), origin);
    }
    if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const job = jobs.get(decodeURIComponent(url.pathname.slice("/jobs/".length)));
      return job ? send(response, 200, publicJob(job), origin) : send(response, 404, "작업을 찾을 수 없습니다.", origin);
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      const input = await readJson(request);
      return send(response, 200, await cancelJob(input.jobId), origin);
    }
    return send(response, 404, "지원하지 않는 경로입니다.", origin);
  } catch (error) {
    return send(response, 400, error?.message || String(error), origin);
  }
});

server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(path.join(path.dirname(configPath), "helper.pid"), String(process.pid), "utf8");
});

function shutdown() {
  for (const job of jobs.values()) {
    if (job.controller) job.controller.abort();
    if (job.process) job.process.kill();
  }
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
