import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({
  AbortSignal,
  URL,
  console,
  chrome: { runtime: { sendMessage: async () => {} } },
});
for (const relative of [
  "../content/adapter-runtime.js",
  "../content/adapters/youtube.js",
  "../content/adapters/twitter.js",
]) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: relative });
}
const api = context.TabMediaAdapters;

function element({ href = "", textContent = "", attributes = {}, content = "" } = {}) {
  return {
    href,
    textContent,
    content,
    currentSrc: "",
    getAttribute(name) {
      return attributes[name] ?? null;
    },
  };
}







test("YouTube watch, shorts, youtu.be 주소를 같은 영상 키로 정규화한다", () => {
  const urls = [
    "https://www.youtube.com/watch?v=abc_DEF-12&list=ignored",
    "https://www.youtube.com/shorts/abc_DEF-12",
    "https://youtu.be/abc_DEF-12?t=3",
  ];
  for (const url of urls) {
    const adapter = api.find(url);
    assert.equal(adapter.type, "youtube");
    assert.equal(adapter.key(url), "abc_DEF-12");
    assert.equal(adapter.canonicalize(url), "https://www.youtube.com/watch?v=abc_DEF-12");
  }
});

test("X와 Twitter 개별 게시물 주소를 같은 status ID로 정규화한다", () => {
  const urls = [
    "https://x.com/AI_money_club/status/2078608252556787800?s=20",
    "https://twitter.com/AI_money_club/status/2078608252556787800/photo/1",
  ];
  for (const url of urls) {
    const adapter = api.find(url);
    assert.equal(adapter.type, "twitter");
    assert.equal(adapter.key(url), "2078608252556787800");
    assert.equal(adapter.canonicalize(url), "https://x.com/AI_money_club/status/2078608252556787800");
  }
  assert.equal(api.find("https://x.com/AI_money_club"), null);
});

test("지원하지 않는 사이트에는 어댑터를 배정하지 않는다", () => {
  assert.equal(api.find("https://example.com/post/1"), null);
});










test("YouTube 분석 결과는 로컬 yt-dlp 작업으로 전달된다", () => {
  const url = "https://www.youtube.com/watch?v=abc_DEF-12";
  const document = {
    title: "테스트 영상 - YouTube",
    querySelector() { return null; },
  };
  const result = api.find(url).extract(document, url);
  assert.equal(result.title, "테스트 영상");
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].kind, "video");
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.assets[0].delivery)),
    { mode: "native", engine: "yt-dlp", pageUrl: url },
  );
});

function twitterDocument(article, statusId = "2078608252556787800") {
  const permalink = {
    closest(selector) { return selector === "article" ? article : null; },
  };
  return {
    querySelectorAll(selector) {
      return selector.includes(`/status/${statusId}`) ? [permalink] : [];
    },
  };
}

test("X 다중 영상 게시물은 게시물 URL 하나와 실제 영상 개수를 Helper에 전달한다", () => {
  const url = "https://x.com/AI_money_club/status/2078608252556787800";
  const article = {
    querySelector(selector) {
      return selector === '[data-testid="User-Name"]' ? { innerText: "こやす69＠AIプロンプト屋\n@AI_money_club" } : null;
    },
    querySelectorAll(selector) {
      if (selector === "video") return [{}, {}];
      return [];
    },
  };
  const result = api.find(url).extract(twitterDocument(article), url);
  assert.equal(result.backend, "native");
  assert.equal(result.title, "こやす69＠AIプロンプト屋 (@AI_money_club) - 2078608252556787800");
  assert.equal(result.mediaCount, 2);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].itemCount, 2);
  assert.equal(result.assets[0].delivery.pageUrl, url);
});

test("X 사진 게시물은 대상 article의 사진만 원본 URL과 순번으로 만든다", () => {
  const url = "https://twitter.com/picture_user/status/1234567890123456789";
  const photos = [
    { currentSrc: "https://pbs.twimg.com/media/AAA111?format=jpg&name=small" },
    { currentSrc: "https://pbs.twimg.com/media/BBB222.png?name=medium" },
  ];
  const article = {
    querySelector(selector) {
      return selector === '[data-testid="User-Name"]' ? { innerText: "사진 계정\n@picture_user" } : null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[href*="/photo/"] img') return photos;
      return [];
    },
  };
  const result = api.find(url).extract(twitterDocument(article, "1234567890123456789"), url);
  assert.equal(result.backend, "chrome");
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets[0].filename, "0001.jpg");
  assert.equal(result.assets[0].url, "https://pbs.twimg.com/media/AAA111?format=jpg&name=orig");
  assert.equal(result.assets[1].filename, "0002.png");
  assert.equal(result.assets[1].url, "https://pbs.twimg.com/media/BBB222.png?format=png&name=orig");
});
