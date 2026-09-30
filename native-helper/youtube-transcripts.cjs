"use strict";

const MAX_PLAYLIST_VIDEOS = 100;

function validatePlaylistUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    throw new Error("HTTPS YouTube 재생목록 URL만 허용됩니다.");
  }
  const listId = url.searchParams.get("list") || "";
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(listId)) throw new Error("재생목록 ID가 올바르지 않습니다.");
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
}

function preferredLanguageKeys(group, language) {
  const keys = Object.keys(group || {});
  const matches = (prefix) => keys.filter((key) => key === prefix || key.startsWith(`${prefix}-`));
  return [...new Set([...matches("ko"), ...matches(language || ""), ...matches("en"), ...keys])];
}

function firstTrack(group, language, wantedLanguage) {
  const keys = preferredLanguageKeys(group, language);
  const selectedLanguage = wantedLanguage
    ? keys.find((key) => key === wantedLanguage || key.startsWith(`${wantedLanguage}-`))
    : keys[0];
  if (!selectedLanguage) return null;
  const formats = Array.isArray(group[selectedLanguage]) ? group[selectedLanguage] : [];
  const format = formats.find((item) => item.ext === "json3")
    || formats.find((item) => item.ext === "vtt")
    || formats[0];
  return format?.url ? { ...format, language: selectedLanguage } : null;
}

function selectSubtitle(info) {
  const manual = info?.subtitles || {};
  const automatic = info?.automatic_captions || {};
  const language = info?.language || "";
  return firstTrack(manual, language, "ko")
    || firstTrack(automatic, language, "ko")
    || firstTrack(manual, language, language)
    || firstTrack(automatic, language, language)
    || firstTrack(manual, language)
    || firstTrack(automatic, language);
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseJson3(text) {
  const data = JSON.parse(text);
  return (data.events || [])
    .filter((event) => Array.isArray(event.segs))
    .map((event) => ({
      start: (Number(event.tStartMs) || 0) / 1000,
      text: decodeEntities(event.segs.map((segment) => segment.utf8 || "").join("")),
    }))
    .filter((segment) => segment.text);
}

function timestampSeconds(value) {
  const parts = String(value).replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts.length === 2 ? parts[0] * 60 + parts[1] : 0;
}

function parseVtt(text) {
  const segments = [];
  for (const block of String(text).replace(/^\uFEFF/, "").split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes(" --> "));
    if (timingIndex < 0) continue;
    const start = timestampSeconds(lines[timingIndex].split(" --> ")[0]);
    const value = decodeEntities(lines.slice(timingIndex + 1).join(" "));
    if (value && value !== segments.at(-1)?.text) segments.push({ start, text: value });
  }
  return segments;
}

function parseSubtitle(ext, text) {
  if (ext === "json3") return parseJson3(text);
  if (ext === "vtt") return parseVtt(text);
  throw new Error(`지원하지 않는 자막 형식입니다: ${ext || "unknown"}`);
}

function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function groupIntoParagraphs(segments) {
  if (!segments.length) return [];
  const paragraphs = [];
  let current = { start: segments[0].start, texts: [] };
  for (let index = 0; index < segments.length; index += 1) {
    current.texts.push(segments[index].text);
    const accumulated = current.texts.join(" ");
    const next = segments[index + 1];
    const sentenceEnd = /[.!?。！？]$/.test(segments[index].text)
      || /(?:다|요|죠|니다|세요|네요|습니다|됩니다|합니다|입니다|한다|된다|니까|지요)$/.test(segments[index].text);
    if (next && (next.start - segments[index].start >= 10 || accumulated.length >= 800
      || (accumulated.length >= 300 && sentenceEnd))) {
      paragraphs.push({ timestamp: formatTimestamp(current.start), text: accumulated });
      current = { start: next.start, texts: [] };
    }
  }
  if (current.texts.length) {
    paragraphs.push({ timestamp: formatTimestamp(current.start), text: current.texts.join(" ") });
  }
  return paragraphs;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function buildTranscriptText(info, segments) {
  const lines = [
    `제목: ${info.title || "제목 없음"}`,
    `채널: ${info.channel || info.uploader || "채널명 없음"}`,
    `길이: ${formatDuration(info.duration)}`,
  ];
  if (info.upload_date) {
    lines.push(`업로드: ${String(info.upload_date).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}`);
  }
  lines.push(
    `URL: ${info.webpage_url || `https://www.youtube.com/watch?v=${info.id || ""}`}`,
    "", "--- 스크립트 ---", "",
    groupIntoParagraphs(segments).map((paragraph) => `[${paragraph.timestamp}]\n${paragraph.text}`).join("\n\n"),
  );
  return lines.join("\n");
}

function validateSubtitleUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "youtube.com" || host.endsWith(".youtube.com")
    || host === "googlevideo.com" || host.endsWith(".googlevideo.com"))) {
    throw new Error("허용되지 않은 자막 URL입니다.");
  }
  return url.href;
}

module.exports = {
  MAX_PLAYLIST_VIDEOS,
  buildTranscriptText,
  parseSubtitle,
  selectSubtitle,
  validatePlaylistUrl,
  validateSubtitleUrl,
};
