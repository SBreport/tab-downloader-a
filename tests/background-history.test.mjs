import assert from "node:assert/strict";
import test from "node:test";

const storage = {};
const messageListeners = [];
const changedListeners = [];
const helperImageStarts = [];
const helperMediaRequests = [];
const helperTranscriptStarts = [];
const shownDownloadIds = [];
const determiningFilenameListeners = [];
let defaultFolderOpenCount = 0;
let helperHelloVersion = "";
let nextDownloadId = 1;
const downloads = new Map();

function selectStorage(keys) {
  if (keys == null) return { ...storage };
  const names = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(names.filter((key) => key in storage).map((key) => [key, storage[key]]));
}

globalThis.chrome = {
  sidePanel: { setPanelBehavior: async () => {} },
  storage: {
    local: {
      get: async (keys) => selectStorage(keys),
      set: async (values) => Object.assign(storage, structuredClone(values)),
      remove: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      },
    },
  },
  runtime: {
    id: "nccjgbgpcokjhaalfdbfmkomielehekd",
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    sendMessage: async () => {},
  },
  declarativeNetRequest: {
    getSessionRules: async () => [],
    updateSessionRules: async () => {},
  },
  downloads: {
    async download(options) {
      const id = nextDownloadId++;
      let filename = options.url.split("/").at(-1);
      const item = { id, url: options.url, finalUrl: options.url, filename, byExtensionId: chrome.runtime.id };
      for (const listener of determiningFilenameListeners) {
        listener(item, (suggestion) => {
          if (suggestion?.filename) filename = suggestion.filename;
        });
      }
      downloads.set(id, {
        id,
        filename: `C:\\Users\\user\\Downloads\\${filename.split("/").join("\\")}`,
        fileSize: 10,
        mime: options.url.includes("html-mime") ? "text/html" : "image/jpeg",
        state: options.url.includes("instant") ? "complete" : options.url.includes("forbidden") ? "interrupted" : "in_progress",
        error: options.url.includes("forbidden") ? "SERVER_FORBIDDEN" : undefined,
      });
      return id;
    },
    async cancel(id) {
      const item = downloads.get(id);
      if (item) item.state = "interrupted";
    },
    async search({ id, filenameRegex }) {
      if (filenameRegex) {
        const pattern = new RegExp(filenameRegex);
        return [...downloads.values()].filter((item) => pattern.test(item.filename));
      }
      return downloads.has(id) ? [downloads.get(id)] : [];
    },
    show(id) {
      shownDownloadIds.push(id);
    },
    showDefaultFolder() {
      defaultFolderOpenCount += 1;
    },
    onDeterminingFilename: { addListener: (listener) => determiningFilenameListeners.push(listener) },
    onChanged: { addListener: (listener) => changedListeners.push(listener) },
  },
  alarms: {
    create: () => {},
    clear: async () => true,
    onAlarm: { addListener: () => {} },
  },
};

globalThis.fetch = async (rawUrl, options = {}) => {
  const url = new URL(rawUrl);
  if (url.pathname === "/hello" && helperHelloVersion) {
    return new Response(JSON.stringify({
      ok: true,
      data: { name: "탭 다운로더 A Media Helper", version: helperHelloVersion },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/probe" || url.pathname === "/start") {
    helperMediaRequests.push({ path: url.pathname, ...JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, data: { outputDirectory: "/Downloads/Vimeo", qualities: [] } }), { status: 200 });
  }
  if (url.pathname === "/start-images") {
    helperImageStarts.push(JSON.parse(options.body || "{}"));
    return new Response(JSON.stringify({
      ok: true,
      data: { status: "starting", outputDirectory: "C:\\Users\\user\\Downloads\\Image Test" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/start-transcripts") {
    helperTranscriptStarts.push(JSON.parse(options.body || "{}"));
    return new Response(JSON.stringify({
      ok: true,
      data: { status: "starting", outputDirectory: "C:\\Users\\user\\Downloads\\Playlist Scripts" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname.startsWith("/jobs/")) {
    return new Response(JSON.stringify({
      ok: true,
      data: { status: "completed", percent: 100, completedFiles: 1, failedFiles: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
};

await import(`../background/service-worker.js?history-test=${Date.now()}`);

async function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`응답 시간 초과: ${message.type}`)), 3000);
    const sendResponse = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const handled = messageListeners.some((listener) => listener(message, {}, sendResponse) === true);
    if (!handled) {
      clearTimeout(timeout);
      reject(new Error(`처리되지 않은 메시지: ${message.type}`));
    }
  });
}

async function completeDownload(id) {
  const item = downloads.get(id);
  item.state = "complete";
  for (const listener of changedListeners) await listener({ id, state: { current: "complete" } });
}

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("조건 대기 시간 초과");
}

test("직접 다운로드 기록은 취소·실패 항목 재시도·기록 삭제를 지원한다", async () => {
  const analysis = {
    type: "twitter",
    title: "기록 테스트",
    canonicalUrl: "https://example.com/post/1",
    complete: true,
    assets: [1, 2].map((number) => ({
      id: String(number),
      kind: "image",
      url: `https://cdn.example.com/${number}.jpg`,
      referer: "https://example.com/post/1",
      filename: `000${number}.jpg`,
      delivery: { mode: "direct" },
    })),
  };

  const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  assert.equal(started.ok, true);
  assert.equal((await sendMessage({ type: "GET_DOWNLOAD_HISTORY" })).jobs.length, 1);

  const canceled = await sendMessage({ type: "CANCEL_DOWNLOAD_JOB", jobId: started.job.id });
  assert.equal(canceled.job.status, "canceled");
  assert.equal(canceled.job.failedAssets.length, 2);

  const retried = await sendMessage({ type: "RETRY_DOWNLOAD_JOB", jobId: started.job.id });
  assert.equal(retried.ok, true);
  assert.notEqual(retried.job.id, started.job.id);
  assert.equal((await sendMessage({ type: "GET_DOWNLOAD_HISTORY" })).jobs.length, 2);

  await Promise.all([completeDownload(3), completeDownload(4)]);
  const history = await sendMessage({ type: "GET_DOWNLOAD_HISTORY" });
  assert.equal(history.jobs[0].status, "completed");

  const removed = await sendMessage({ type: "DELETE_DOWNLOAD_HISTORY" });
  assert.equal(removed.removed, 2);
  assert.equal(removed.jobs.length, 0);
});

test("즉시 완료와 동시 작업 생성도 기록과 완료 수를 잃지 않는다", async () => {
  const makeAnalysis = (number) => ({
    type: "twitter",
    title: `즉시 완료 ${number}`,
    canonicalUrl: `https://example.com/post/${number}`,
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: `https://instant.example.com/${number}.jpg`,
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  });
  const results = await Promise.all([1, 2].map((number) => sendMessage({
    type: "START_DOWNLOAD",
    analysis: makeAnalysis(number),
    root: "History Test",
  })));
  assert.ok(results.every((result) => ["waiting", "completed"].includes(result.job.status)));
  const history = await sendMessage({ type: "GET_DOWNLOAD_HISTORY" });
  assert.equal(history.jobs.length, 2);
  assert.ok(history.jobs.every((job) => job.completed === 1));
});

test("이미지 확장자로 저장돼도 HTML MIME 응답은 실패로 기록한다", async () => {
  const analysis = {
    type: "twitter",
    title: "MIME 검사",
    canonicalUrl: "https://example.com/post/mime",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://instant.example.com/html-mime.jpg",
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  };
  const result = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  assert.equal(result.job.status, "finished_with_errors");
  assert.equal(result.job.failed, 1);
  assert.match(result.job.errors[0], /이미지가 아닌 응답/);
});





test("WebP 출력은 직접 이미지 작업도 Helper 변환 작업으로 전달한다", async () => {
  helperHelloVersion = "0.7.1";
  const downloadIdBefore = nextDownloadId;
  const analysis = {
    type: "twitter",
    title: "WebP 변환",
    canonicalUrl: "https://x.com/example/status/123",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://pbs.twimg.com/media/example?format=png&name=orig",
      referer: "https://x.com/example/status/123",
      filename: "0001.png",
      delivery: { mode: "direct" },
    }],
  };

  try {
    const started = await sendMessage({
      type: "START_DOWNLOAD",
      analysis,
      root: "History Test",
      options: { imageFormat: "webp" },
    });
    assert.equal(started.ok, true);
    assert.equal(started.job.backend, "native");
    assert.equal(started.job.imageFormat, "webp");
    assert.equal(nextDownloadId, downloadIdBefore);
    const payload = helperImageStarts.at(-1);
    assert.equal(payload.type, "twitter");
    assert.equal(payload.imageFormat, "webp");
    assert.equal(payload.assets[0].filename, "0001.png");
  } finally {
    helperHelloVersion = "";
  }
});


test("YouTube 재생목록 스크립트는 Helper 0.9.0과 전용 엔진을 사용한다", async () => {
  const analysis = {
    type: "youtube_playlist_transcript",
    title: "테스트 재생목록",
    canonicalUrl: "https://www.youtube.com/playlist?list=PL1234567890_test",
    backend: "native",
    mediaCount: 3,
    expectedCount: 3,
    complete: true,
    assets: [{
      id: "PL1234567890_test",
      kind: "document",
      filename: "테스트 재생목록",
      delivery: {
        mode: "native",
        engine: "youtube-transcripts",
        pageUrl: "https://www.youtube.com/playlist?list=PL1234567890_test",
      },
    }],
  };

  helperHelloVersion = "0.8.5";
  const rejected = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /0\.9\.0 이상/);

  helperHelloVersion = "0.9.0";
  try {
    const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
    assert.equal(started.ok, true);
    assert.equal(started.job.engine, "youtube-transcripts");
    assert.equal(helperTranscriptStarts.at(-1).mediaCount, 3);
    assert.equal(helperTranscriptStarts.at(-1).url, analysis.canonicalUrl);
  } finally {
    helperHelloVersion = "";
  }
});

test("Chrome 다운로드 기록에서 사라진 작업은 종료 상태로 복구한다", async () => {
  const analysis = {
    type: "twitter",
    title: "사라진 다운로드",
    canonicalUrl: "https://example.com/post/missing-download",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://cdn.example.com/missing-download.jpg",
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  };

  const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  const [downloadId] = Object.entries(storage.activeDownloadMap)
    .find(([, entry]) => entry.jobId === started.job.id);
  downloads.delete(Number(downloadId));

  const history = await sendMessage({ type: "GET_DOWNLOAD_HISTORY" });
  const recovered = history.jobs.find((job) => job.id === started.job.id);
  assert.equal(recovered.status, "finished_with_errors");
  assert.equal(recovered.failed, 1);
  assert.match(recovered.errors[0], /DOWNLOAD_NOT_FOUND/);
});

test("활성 매핑이 잠시 없는 새 작업은 고아 작업으로 처리하지 않는다", async () => {
  const analysis = {
    type: "twitter",
    title: "진행 중 다운로드",
    canonicalUrl: "https://example.com/post/recent",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://cdn.example.com/recent.jpg",
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  };

  const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  const [downloadId] = Object.entries(storage.activeDownloadMap)
    .find(([, entry]) => entry.jobId === started.job.id);
  delete storage.activeDownloadMap[downloadId];

  const history = await sendMessage({ type: "GET_DOWNLOAD_HISTORY" });
  const current = history.jobs.find((job) => job.id === started.job.id);
  assert.equal(current.status, "downloading");

  await sendMessage({ type: "CANCEL_DOWNLOAD_JOB", jobId: started.job.id });
});

test("활성 매핑이 유실된 오래된 작업도 완료 삭제 전에 정리한다", async () => {
  const analysis = {
    type: "twitter",
    title: "고아 다운로드",
    canonicalUrl: "https://example.com/post/orphan",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://cdn.example.com/orphan.jpg",
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  };

  const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  const [downloadId] = Object.entries(storage.activeDownloadMap)
    .find(([, entry]) => entry.jobId === started.job.id);
  delete storage.activeDownloadMap[downloadId];
  storage[`job:${started.job.id}`].updatedAt = new Date(Date.now() - 120_000).toISOString();

  const removed = await sendMessage({ type: "DELETE_DOWNLOAD_HISTORY" });
  assert.ok(removed.removed >= 1);
  assert.equal(removed.jobs.some((job) => job.id === started.job.id), false);
});

test("Chrome 직접 다운로드 폴더 열기는 Helper 없이 chrome.downloads.show를 쓴다", async () => {
  const analysis = {
    type: "twitter",
    title: "폴더 열기 (테스트)",
    canonicalUrl: "https://example.com/post/folder",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://instant.example.com/folder.jpg",
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  };

  const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  shownDownloadIds.length = 0;
  const opened = await sendMessage({ type: "OPEN_DOWNLOAD_FOLDER", jobId: started.job.id });

  assert.equal(opened.ok, true);
  assert.equal(shownDownloadIds.length, 1);
  assert.equal(opened.path, started.job.relativeDirectory);
});

test("Chrome 다운로드 파일을 찾지 못하면 기본 다운로드 폴더를 연다", async () => {
  const analysis = {
    type: "twitter",
    title: "이동된 파일",
    canonicalUrl: "https://example.com/post/moved-folder",
    complete: true,
    assets: [{
      id: "1",
      kind: "image",
      url: "https://instant.example.com/moved-folder.jpg",
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  };

  const started = await sendMessage({ type: "START_DOWNLOAD", analysis, root: "History Test" });
  downloads.clear();
  defaultFolderOpenCount = 0;
  const opened = await sendMessage({ type: "OPEN_DOWNLOAD_FOLDER", jobId: started.job.id });

  assert.equal(opened.ok, true);
  assert.equal(defaultFolderOpenCount, 1);
});


test("Vimeo 품질 조회·시작·재시도에서 Referer를 전달하고 구 Helper는 거부한다", async () => {
  const url = "https://player.vimeo.com/video/1115098578";
  const referer = "https://ytory.com/view/?idx=166179015";
  const analysis = { type: "vimeo", title: "인트로", complete: true, assets: [{ kind: "video", filename: "인트로.mp4", delivery: { mode: "native", engine: "yt-dlp", pageUrl: url, referer } }] };
  helperHelloVersion = "0.9.0";
  assert.equal((await sendMessage({ type: "PROBE_NATIVE_MEDIA", url, referer })).ok, false);
  assert.equal((await sendMessage({ type: "START_DOWNLOAD", analysis })).ok, false);
  helperHelloVersion = "0.10.1";
  assert.equal((await sendMessage({ type: "PROBE_NATIVE_MEDIA", url, referer })).ok, true);
  assert.equal(helperMediaRequests.at(-1).referer, referer);
  const started = await sendMessage({ type: "START_DOWNLOAD", analysis });
  assert.equal(started.ok, true);
  assert.equal(helperMediaRequests.at(-1).referer, referer);
  assert.equal(started.job.retrySpec.analysis.assets[0].delivery.referer, referer);
  assert.equal(helperMediaRequests.at(-1).url, url);
});

test("여러 직접 다운로드 작업은 저장된 대기열 순서대로 하나씩 실행된다", async () => {
  const makeAnalysis = (number) => ({
    type: "twitter",
    title: `대기열 ${number}`,
    canonicalUrl: `https://example.com/queue/${number}`,
    complete: true,
    assets: [{
      id: String(number),
      kind: "image",
      url: `https://cdn.example.com/queue-${number}.jpg`,
      filename: "0001.jpg",
      delivery: { mode: "direct" },
    }],
  });

  const first = await sendMessage({ type: "START_DOWNLOAD", analysis: makeAnalysis(1), root: "Queue Test" });
  const second = await sendMessage({ type: "START_DOWNLOAD", analysis: makeAnalysis(2), root: "Queue Test" });
  const third = await sendMessage({ type: "START_DOWNLOAD", analysis: makeAnalysis(3), root: "Queue Test" });
  assert.equal(first.job.status, "downloading");
  assert.equal(second.job.status, "waiting");
  assert.equal(third.job.status, "waiting");

  let queue = (await sendMessage({ type: "GET_DOWNLOAD_QUEUE" })).queue;
  assert.deepEqual(queue.items.map((job) => job.id), [second.job.id, third.job.id]);
  queue = (await sendMessage({
    type: "MOVE_DOWNLOAD_QUEUE", jobId: third.job.id, direction: "up",
  })).queue;
  assert.deepEqual(queue.items.map((job) => job.id), [third.job.id, second.job.id]);
  queue = (await sendMessage({ type: "REMOVE_DOWNLOAD_QUEUE", jobId: second.job.id })).queue;
  assert.deepEqual(queue.items.map((job) => job.id), [third.job.id]);

  await sendMessage({ type: "SET_DOWNLOAD_QUEUE_PAUSED", paused: true });
  const [firstDownloadId] = Object.entries(storage.activeDownloadMap)
    .find(([, entry]) => entry.jobId === first.job.id);
  await completeDownload(Number(firstDownloadId));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(storage[`job:${third.job.id}`].status, "waiting");

  await sendMessage({ type: "SET_DOWNLOAD_QUEUE_PAUSED", paused: false });
  await waitFor(() => storage[`job:${third.job.id}`]?.status === "downloading");
  const [thirdDownloadId] = Object.entries(storage.activeDownloadMap)
    .find(([, entry]) => entry.jobId === third.job.id);
  await completeDownload(Number(thirdDownloadId));
  await waitFor(() => storage[`job:${third.job.id}`]?.status === "completed");
});

test('A는 지원하지 않는 타입의 직접 다운로드 요청을 거부한다', async () => {
  for (const type of ['unsupported_site', 'unknown_image']) {
    const result = await sendMessage({ type: 'START_DOWNLOAD', analysis: {
      type, title: 'unsupported', complete: true,
      assets: [{ kind: 'image', url: 'https://example.com/1.jpg', filename: '0001.jpg', delivery: { mode: 'direct' } }],
    } });
    assert.equal(result.ok, false);
    assert.match(result.error, /버전 A에서 지원하지 않는 사이트/);
  }
});
