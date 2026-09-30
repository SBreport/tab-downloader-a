import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildTranscriptText,
  parseSubtitle,
  selectSubtitle,
  validatePlaylistUrl,
  validateSubtitleUrl,
} = require("../native-helper/youtube-transcripts.cjs");

test("YouTube 재생목록 URL만 정규화한다", () => {
  assert.equal(
    validatePlaylistUrl("https://www.youtube.com/watch?v=abc&list=PL1234567890_test"),
    "https://www.youtube.com/playlist?list=PL1234567890_test",
  );
  assert.throws(() => validatePlaylistUrl("https://example.com/playlist?list=PL1234567890_test"));
  assert.throws(() => validatePlaylistUrl("https://www.youtube.com/playlist"));
});

test("수동 한국어 자막을 자동 자막보다 우선한다", () => {
  const selected = selectSubtitle({
    language: "en",
    subtitles: { ko: [{ ext: "json3", url: "https://www.youtube.com/api/timedtext?manual" }] },
    automatic_captions: { ko: [{ ext: "json3", url: "https://www.youtube.com/api/timedtext?auto" }] },
  });
  assert.match(selected.url, /manual/);
  assert.equal(validateSubtitleUrl(selected.url), selected.url);
  assert.throws(() => validateSubtitleUrl("https://example.com/captions.json3"));
});

test("JSON3 자막을 문단형 TXT로 변환한다", () => {
  const segments = parseSubtitle("json3", JSON.stringify({ events: [
    { tStartMs: 0, segs: [{ utf8: "안녕하세요." }] },
    { tStartMs: 12000, segs: [{ utf8: "두 번째 문장입니다." }] },
  ] }));
  const text = buildTranscriptText({
    id: "abc123", title: "테스트 영상", channel: "테스트 채널", duration: 70, upload_date: "20260825",
  }, segments);
  assert.match(text, /제목: 테스트 영상/);
  assert.match(text, /업로드: 2026-08-25/);
  assert.match(text, /\[00:00\]\n안녕하세요\./);
  assert.match(text, /\[00:12\]\n두 번째 문장입니다\./);
});
