import { helperRequest, probeHelper } from "./helper-client.js";
import { buildDownloadFilename, sanitizeRoot } from "../shared/path-utils.js";

const DEFAULT_ROOT = "탭 다운로더 A";
const LEGACY_ROOTS = new Set(["Tab Media Downloader"]);
const MAX_DIRECT_ASSETS_PER_JOB = 1000;
const DOWNLOAD_MAP_KEY = "activeDownloadMap";
const JOB_HISTORY_KEY = "downloadJobHistory";
const JOB_QUEUE_KEY = "downloadJobQueue";
const QUEUE_PAUSED_KEY = "downloadQueuePaused";
const MAX_HISTORY_JOBS = 50;
const MAX_QUEUED_JOBS = 10;
const ORPHAN_JOB_GRACE_MS = 60_000;
const CONVERTIBLE_IMAGE_TYPES = new Set(["twitter", "instagram"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "finished_with_errors", "canceled"]);
const pendingFilenames = new Map();

function normalizeBrandRoot(value) {
  const root = sanitizeRoot(value || DEFAULT_ROOT);
  return LEGACY_ROOTS.has(root) ? DEFAULT_ROOT : root;
}
const activeHelperPolls = new Set();
const jobMutationQueues = new Map();
let historyMutationQueue = Promise.resolve();
let downloadMapMutationQueue = Promise.resolve();
let queueMutationQueue = Promise.resolve();
let queueRunnerPromise = null;
let queuePumpRequested = false;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn("side panel setup failed", error));

const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (values) => chrome.storage.local.set(values);
const storageRemove = (keys) => chrome.storage.local.remove(keys);

function withJobLock(jobId, task) {
  const previous = jobMutationQueues.get(jobId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  jobMutationQueues.set(jobId, current);
  return current.finally(() => {
    if (jobMutationQueues.get(jobId) === current) jobMutationQueues.delete(jobId);
  });
}

function withHistoryLock(task) {
  const current = historyMutationQueue.catch(() => {}).then(task);
  historyMutationQueue = current.catch(() => {});
  return current;
}

function withDownloadMapLock(task) {
  const current = downloadMapMutationQueue.catch(() => {}).then(task);
  downloadMapMutationQueue = current.catch(() => {});
  return current;
}

function withQueueLock(task) {
  const current = queueMutationQueue.catch(() => {}).then(task);
  queueMutationQueue = current.catch(() => {});
  return current;
}

async function createJob(job) {
  return withHistoryLock(async () => {
    const state = await storageGet(null);
    const previous = Array.isArray(state[JOB_HISTORY_KEY]) ? state[JOB_HISTORY_KEY] : [];
    const ordered = [job.id, ...previous.filter((id) => id !== job.id)];
    const recordFor = (id) => id === job.id ? job : state[`job:${id}`];
    const activeCount = ordered.filter((id) => {
      const record = recordFor(id);
      return record && !TERMINAL_STATUSES.has(record.status);
    }).length;
    let terminalBudget = Math.max(0, MAX_HISTORY_JOBS - activeCount);
    const history = ordered.filter((id) => {
      const record = recordFor(id);
      if (!record) return false;
      if (!TERMINAL_STATUSES.has(record.status)) return true;
      if (terminalBudget <= 0) return false;
      terminalBudget -= 1;
      return true;
    });
    const pruned = previous.filter((id) => !history.includes(id));
    await storageSet({
      [`job:${job.id}`]: job,
      [JOB_HISTORY_KEY]: history,
      lastJobId: job.id,
      downloadRoot: job.root,
    });
    if (pruned.length) await storageRemove(pruned.map((id) => `job:${id}`));
  });
}

async function getJob(jobId) {
  const stored = await storageGet(`job:${jobId}`);
  return stored[`job:${jobId}`] || null;
}

async function getHistoryJobs() {
  const state = await storageGet(null);
  let ids = Array.isArray(state[JOB_HISTORY_KEY]) ? state[JOB_HISTORY_KEY] : [];
  if (!ids.length) {
    const recovered = Object.entries(state)
      .filter(([key, value]) => key.startsWith("job:") && value?.id)
      .map(([, value]) => value)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const active = recovered.filter((job) => !TERMINAL_STATUSES.has(job.status));
    const terminal = recovered.filter((job) => TERMINAL_STATUSES.has(job.status))
      .slice(0, Math.max(0, MAX_HISTORY_JOBS - active.length));
    ids = [...active, ...terminal]
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .map((job) => job.id);
    await storageSet({ [JOB_HISTORY_KEY]: ids });
  }
  return ids.map((id) => state[`job:${id}`]).filter(Boolean);
}

function queueJobSummary(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    rangeLabel: job.rangeLabel || "",
    total: Number(job.total) || 0,
    createdAt: job.createdAt,
    status: job.status,
  };
}

async function getQueueState() {
  const state = await storageGet([JOB_QUEUE_KEY, QUEUE_PAUSED_KEY]);
  const ids = Array.isArray(state[JOB_QUEUE_KEY]) ? state[JOB_QUEUE_KEY] : [];
  const jobs = await Promise.all(ids.map((id) => getJob(id)));
  return {
    paused: Boolean(state[QUEUE_PAUSED_KEY]),
    items: jobs.map(queueJobSummary).filter((job) => job?.status === "waiting"),
  };
}

async function notifyQueueUpdated() {
  const queue = await getQueueState();
  chrome.runtime.sendMessage({ type: "DOWNLOAD_QUEUE_UPDATED", queue }).catch(() => {});
  return queue;
}

async function pauseQueueIfPending() {
  const queue = await getQueueState();
  if (!queue.items.length) return queue;
  await storageSet({ [QUEUE_PAUSED_KEY]: true });
  return notifyQueueUpdated();
}

function queueIdentity(analysis, options = {}) {
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const first = assets[0];
  const last = assets.at(-1);
  return [
    analysis?.type || "",
    analysis?.canonicalUrl || first?.delivery?.pageUrl || "",
    analysis?.rangeLabel || "",
    assets.length,
    first?.id || first?.url || "",
    last?.id || last?.url || "",
    options.quality || "best",
    options.imageFormat || "original",
  ].join("\n");
}

async function enqueueDownloadJob(analysis, requestedRoot, options = {}) {
  assertAnalysis(analysis);
  const root = normalizeBrandRoot(requestedRoot);
  const queueKey = queueIdentity(analysis, options);
  const createdAt = new Date().toISOString();
  const jobId = `${Date.now()}-${crypto.randomUUID()}`;

  const startImmediately = await withQueueLock(async () => {
    const jobs = await getHistoryJobs();
    if (jobs.some((job) => !TERMINAL_STATUSES.has(job.status) && job.queueKey === queueKey)) {
      throw new Error("같은 작업이 이미 진행 중이거나 대기열에 있습니다.");
    }
    const state = await storageGet([JOB_QUEUE_KEY, QUEUE_PAUSED_KEY]);
    const ids = Array.isArray(state[JOB_QUEUE_KEY]) ? state[JOB_QUEUE_KEY] : [];
    if (ids.length >= MAX_QUEUED_JOBS) {
      throw new Error(`대기열은 최대 ${MAX_QUEUED_JOBS}개까지 등록할 수 있습니다.`);
    }
    const active = jobs.some((job) => !TERMINAL_STATUSES.has(job.status) && job.status !== "waiting");
    const job = {
      id: jobId,
      backend: "queue",
      type: analysis.type,
      title: analysis.title,
      rangeLabel: analysis.rangeLabel || "",
      root,
      total: Array.isArray(analysis.assets) ? analysis.assets.length : 1,
      queued: 0,
      completed: 0,
      failed: 0,
      errors: [],
      status: "waiting",
      sourceUrl: analysis.canonicalUrl || "",
      queueKey,
      queueManaged: true,
      queueSpec: { analysis, root, options },
      createdAt,
      updatedAt: createdAt,
    };
    await createJob(job);
    await storageSet({ [JOB_QUEUE_KEY]: [...ids, jobId] });
    return !active && !ids.length && !state[QUEUE_PAUSED_KEY];
  });

  const runner = scheduleQueuePump();
  if (startImmediately) await runner;
  const job = await getJob(jobId);
  if (startImmediately && job?.status === "failed") {
    throw new Error(job.errors?.at(-1) || "다운로드 작업을 시작하지 못했습니다.");
  }
  return { job, queue: await notifyQueueUpdated() };
}

async function claimNextQueuedJob() {
  return withQueueLock(async () => {
    const state = await storageGet([JOB_QUEUE_KEY, QUEUE_PAUSED_KEY]);
    if (state[QUEUE_PAUSED_KEY]) return null;
    const jobs = await getHistoryJobs();
    if (jobs.some((job) => !TERMINAL_STATUSES.has(job.status) && job.status !== "waiting")) return null;

    const ids = Array.isArray(state[JOB_QUEUE_KEY]) ? state[JOB_QUEUE_KEY] : [];
    const waiting = [];
    let selected = null;
    for (const id of ids) {
      const job = await getJob(id);
      if (job?.status !== "waiting") continue;
      if (!selected) selected = job;
      else waiting.push(id);
    }
    if (!selected) {
      if (ids.length) await storageSet({ [JOB_QUEUE_KEY]: [] });
      return null;
    }
    await storageSet({ [JOB_QUEUE_KEY]: waiting });
    await updateJob(selected.id, (job) => ({ ...job, status: "starting" }));
    return selected;
  });
}

async function runDownloadQueue() {
  while (true) {
    const queued = await claimNextQueuedJob();
    if (!queued) return;
    const spec = queued.queueSpec;
    try {
      await startDownloadJob(spec.analysis, spec.root, spec.options, {
        id: queued.id,
        createdAt: queued.createdAt,
        queueKey: queued.queueKey,
        queueManaged: true,
      });
    } catch (error) {
      await updateJob(queued.id, (job) => ({
        ...job,
        failed: Math.max(1, Number(job.failed) || 0),
        status: "failed",
        errors: [...(job.errors || []), error?.message || String(error)].slice(-20),
      }));
      await pauseQueueIfPending();
    }
    await notifyQueueUpdated();
    const current = await getJob(queued.id);
    if (!TERMINAL_STATUSES.has(current?.status)) return;
  }
}

function scheduleQueuePump() {
  if (queueRunnerPromise) {
    queuePumpRequested = true;
    return queueRunnerPromise;
  }
  queuePumpRequested = false;
  queueRunnerPromise = runDownloadQueue().finally(() => {
    queueRunnerPromise = null;
    if (queuePumpRequested) scheduleQueuePump();
  });
  return queueRunnerPromise;
}

async function moveQueuedJob(jobId, direction) {
  await withQueueLock(async () => {
    const state = await storageGet(JOB_QUEUE_KEY);
    const ids = Array.isArray(state[JOB_QUEUE_KEY]) ? state[JOB_QUEUE_KEY] : [];
    const index = ids.indexOf(jobId);
    const target = index + (direction === "up" ? -1 : direction === "down" ? 1 : 0);
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await storageSet({ [JOB_QUEUE_KEY]: ids });
  });
  return notifyQueueUpdated();
}

async function removeQueuedJob(jobId) {
  await withQueueLock(async () => {
    const job = await getJob(jobId);
    if (!job || job.status !== "waiting") throw new Error("대기 중인 작업만 제거할 수 있습니다.");
    const state = await storageGet([JOB_QUEUE_KEY, JOB_HISTORY_KEY]);
    const ids = Array.isArray(state[JOB_QUEUE_KEY]) ? state[JOB_QUEUE_KEY] : [];
    const history = Array.isArray(state[JOB_HISTORY_KEY]) ? state[JOB_HISTORY_KEY] : [];
    await storageSet({
      [JOB_QUEUE_KEY]: ids.filter((id) => id !== jobId),
      [JOB_HISTORY_KEY]: history.filter((id) => id !== jobId),
    });
    await storageRemove(`job:${jobId}`);
  });
  return notifyQueueUpdated();
}

async function setQueuePaused(paused) {
  await storageSet({ [QUEUE_PAUSED_KEY]: Boolean(paused) });
  const queue = await notifyQueueUpdated();
  if (!paused) scheduleQueuePump();
  return queue;
}

async function recoverClaimedQueueJobs() {
  await withQueueLock(async () => {
    const state = await storageGet(null);
    const history = Array.isArray(state[JOB_HISTORY_KEY]) ? state[JOB_HISTORY_KEY] : [];
    const ids = Array.isArray(state[JOB_QUEUE_KEY]) ? state[JOB_QUEUE_KEY] : [];
    const recovered = [];
    for (const id of history) {
      const job = state[`job:${id}`];
      if (job?.backend !== "queue" || job.status !== "starting") continue;
      const next = { ...job, status: "waiting", updatedAt: new Date().toISOString() };
      await storageSet({ [`job:${id}`]: next });
      recovered.push(id);
    }
    if (recovered.length) {
      await storageSet({ [JOB_QUEUE_KEY]: [...new Set([...recovered, ...ids])] });
    }
  });
}

async function updateJob(jobId, updater) {
  return withJobLock(jobId, async () => {
    const key = `job:${jobId}`;
    const stored = await storageGet(key);
    const current = stored[key];
    if (!current) return null;
    const proposed = updater(current);
    const next = {
      ...proposed,
      status: TERMINAL_STATUSES.has(current.status) ? current.status : proposed.status,
      updatedAt: new Date().toISOString(),
    };
    await storageSet({ [key]: next });
    chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", job: next }).catch(() => {});
    return next;
  });
}

async function registerDownload(downloadId, jobId, index, filename, asset) {
  return withDownloadMapLock(async () => {
    const stored = await storageGet(DOWNLOAD_MAP_KEY);
    const map = stored[DOWNLOAD_MAP_KEY] || {};
    map[String(downloadId)] = { jobId, index, filename, asset };
    await storageSet({ [DOWNLOAD_MAP_KEY]: map });
  });
}

async function takeDownloadEntry(downloadId) {
  return withDownloadMapLock(async () => {
    const stored = await storageGet(DOWNLOAD_MAP_KEY);
    const map = stored[DOWNLOAD_MAP_KEY] || {};
    const entry = map[String(downloadId)];
    if (!entry) return null;
    delete map[String(downloadId)];
    await storageSet({ [DOWNLOAD_MAP_KEY]: map });
    return entry;
  });
}

// ponytail: Chrome 직접 다운로드 폴더는 Helper 없이 chrome.downloads.show로 연다.
async function showDirectDownload(job) {
  if (!job?.relativeDirectory) return false;
  const filenameRegex = job.relativeDirectory
    .split("/")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  const [item] = await chrome.downloads.search({
    filenameRegex,
    exists: true,
    limit: 1,
    orderBy: ["-startTime"],
  });
  if (!item) return false;
  chrome.downloads.show(item.id);
  return true;
}

async function takeJobDownloadEntries(jobId) {
  return withDownloadMapLock(async () => {
    const stored = await storageGet(DOWNLOAD_MAP_KEY);
    const map = stored[DOWNLOAD_MAP_KEY] || {};
    const entries = Object.entries(map).filter(([, entry]) => entry.jobId === jobId);
    for (const [downloadId] of entries) delete map[downloadId];
    await storageSet({ [DOWNLOAD_MAP_KEY]: map });
    return entries;
  });
}

async function installRefererRules(assets) {
  const groups = new Map();
  for (const asset of assets) {
    if (!asset.referer) continue;
    try {
      const host = new URL(asset.url).hostname;
      groups.set(`${host}\n${asset.referer}`, { host, referer: asset.referer });
    } catch {
      // 잘못된 URL은 실제 다운로드 단계에서 개별 오류로 처리한다.
    }
  }
  if (!groups.size) return [];

  const existing = await chrome.declarativeNetRequest.getSessionRules();
  let nextId = Math.max(1000, ...existing.map((rule) => rule.id)) + 1;
  const rules = [...groups.values()].map(({ host, referer }) => ({
    id: nextId++,
    priority: 100,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Referer", operation: "set", value: referer }],
    },
    condition: {
      requestDomains: [host],
      resourceTypes: ["main_frame", "sub_frame", "image", "media", "other", "xmlhttprequest"],
    },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
  return rules.map((rule) => rule.id);
}

async function removeRefererRules(ruleIds = []) {
  if (ruleIds.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  }
}

async function finishDirectJobIfNeeded(job) {
  if (!job || !TERMINAL_STATUSES.has(job.status)) return;
  await removeRefererRules(job.ruleIds).catch(() => {});
  scheduleQueuePump();
}

function assertAnalysis(analysis) {
  if (!["youtube", "twitter", "vimeo", "youtube_playlist_transcript"].includes(analysis?.type)) {
    throw new Error("버전 A에서 지원하지 않는 사이트입니다.");
  }
  if (!analysis || !Array.isArray(analysis.assets) || !analysis.assets.length) {
    throw new Error("다운로드할 미디어 목록이 없습니다.");
  }
  if (analysis.complete === false) {
    throw new Error("미디어 목록이 아직 완전하지 않습니다. 탭을 다시 분석해 주세요.");
  }
}

function helperSupportsVersion(version, required) {
  const parts = String(version || "").split(".").map((value) => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < required.length; index += 1) {
    if ((parts[index] || 0) !== required[index]) return (parts[index] || 0) > required[index];
  }
  return true;
}

async function startDownloadJob(analysis, requestedRoot, options = {}, context = {}) {
  const imageFormat = options.imageFormat || "original";
  if (!new Set(["original", "webp"]).has(imageFormat)) {
    throw new Error("지원하지 않는 이미지 출력 형식입니다.");
  }
  if (imageFormat === "webp") {
    assertAnalysis(analysis);
    if (!CONVERTIBLE_IMAGE_TYPES.has(analysis.type) || analysis.assets.some((asset) => asset.kind !== "image")) {
      throw new Error("이 작업은 WebP 이미지 변환을 지원하지 않습니다.");
    }
    const helper = await probeHelper();
    if (analysis.type === "instagram" && !helperSupportsVersion(helper.version, [0, 12, 0])) {
      throw new Error("Instagram WebP 변환에는 Media Helper 0.12.0 이상이 필요합니다. Helper를 업데이트해 주세요.");
    }
    if (!helperSupportsVersion(helper.version, [0, 7, 0])) {
      throw new Error("WebP 변환에는 Media Helper 0.7.0 이상이 필요합니다. Helper를 다시 설치해 주세요.");
    }
    const nativeAnalysis = {
      ...analysis,
      backend: "native",
      assets: analysis.assets.map((asset) => ({
        ...asset,
        delivery: { mode: "native", engine: "http-images" },
      })),
    };
    return startNativeDownloadJob(nativeAnalysis, requestedRoot, { ...options, imageFormat }, context);
  }

  const hasNativeAssets = analysis?.backend === "native" ||
    analysis?.assets?.some((asset) => asset.delivery?.mode === "native");
  if (hasNativeAssets) return startNativeDownloadJob(analysis, requestedRoot, options, context);

  return startDirectDownloadJob(analysis, requestedRoot, context);
}

async function startDirectDownloadJob(analysis, requestedRoot, context = {}) {
  assertAnalysis(analysis);
  const assets = analysis.assets.filter((asset) => asset.delivery?.mode !== "native");
  if (!assets.length) throw new Error("Chrome으로 직접 받을 파일이 없습니다.");
  if (assets.length > MAX_DIRECT_ASSETS_PER_JOB) {
    throw new Error(`한 작업은 최대 ${MAX_DIRECT_ASSETS_PER_JOB}개까지 지원합니다.`);
  }

  const jobId = context.id || `${Date.now()}-${crypto.randomUUID()}`;
  const root = normalizeBrandRoot(requestedRoot);
  const directoryTitle = analysis.directoryTitle || analysis.title;
  const folders = [...new Set(assets.map((asset) => asset.folder).filter(Boolean))];
  const commonFolder = folders.length === 1 ? folders[0] : "";
  const ruleIds = await installRefererRules(assets);
  const job = {
    id: jobId,
    backend: "chrome",
    type: analysis.type,
    title: analysis.title,
    rangeLabel: analysis.rangeLabel || "",
    root,
    total: assets.length,
    queued: 0,
    completed: 0,
    failed: 0,
    errors: [],
    failedAssets: [],
    status: "queuing",
    sourceUrl: analysis.canonicalUrl || "",
    queueKey: context.queueKey,
    queueManaged: Boolean(context.queueManaged),
    relativeDirectory: buildDownloadFilename(root, analysis.type, directoryTitle, "placeholder.bin", commonFolder)
      .split("/").slice(0, -1).join("/"),
    ruleIds,
    createdAt: context.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await createJob(job);

  for (let index = 0; index < assets.length; index += 1) {
    const latest = await getJob(jobId);
    if (latest?.status === "canceled") {
      await updateJob(jobId, (current) => ({
        ...current,
        failedAssets: uniqueAssets([...(current.failedAssets || []), ...assets.slice(index)]),
      }));
      break;
    }
    const asset = assets[index];
    try {
      const filename = buildDownloadFilename(
        root,
        analysis.type,
        directoryTitle,
        asset.filename,
        asset.folder,
      );
      pendingFilenames.set(asset.url, filename);
      const downloadId = await chrome.downloads.download({
        url: asset.url,
        filename,
        conflictAction: "uniquify",
        saveAs: false,
      });
      await registerDownload(downloadId, jobId, index, filename, asset);
      await reconcileDirectDownload(downloadId);
      if ((await getJob(jobId))?.status === "canceled") {
        await takeDownloadEntry(downloadId);
        await chrome.downloads.cancel(downloadId).catch(() => {});
        await updateJob(jobId, (current) => ({
          ...current,
          failedAssets: uniqueAssets([...(current.failedAssets || []), ...assets.slice(index)]),
        }));
        break;
      }
      await updateJob(jobId, (current) => ({
        ...current,
        queued: current.queued + 1,
        status: "downloading",
      }));
    } catch (error) {
      pendingFilenames.delete(asset.url);
      await updateJob(jobId, (current) => ({
        ...current,
        failed: current.failed + 1,
        failedAssets: [...(current.failedAssets || []), asset],
        errors: [...current.errors, `${asset.filename}: ${error?.message || error}`].slice(-20),
      }));
    }
  }

  const finalJob = await updateJob(jobId, (current) => ({
    ...current,
    status: current.status === "canceled"
      ? "canceled"
      :
      current.completed + current.failed >= current.total
        ? current.failed
          ? "finished_with_errors"
          : "completed"
        : "downloading",
  }));
  await finishDirectJobIfNeeded(finalJob);
  if (finalJob?.retriedBy) return (await getJob(finalJob.retriedBy)) || finalJob;
  return finalJob;
}

async function requireEmbeddedVideoHelper() {
  const helper = await probeHelper();
  if (!helperSupportsVersion(helper.version, [0, 10, 0])) {
    throw new Error("페이지 내 영상에는 Media Helper 0.10.0 이상이 필요합니다. Helper를 업데이트해 주세요.");
  }
}

async function startNativeDownloadJob(analysis, requestedRoot, options = {}, context = {}) {
  assertAnalysis(analysis);
  const nativeAssets = analysis.assets.filter((candidate) => candidate.delivery?.mode === "native");
  const asset = nativeAssets[0];
  if (!asset) throw new Error("Media Helper로 처리할 미디어가 없습니다.");
  const engine = asset.delivery?.engine;
  if (!["yt-dlp", "http-images", "youtube-transcripts"].includes(engine)
    || nativeAssets.some((item) => item.delivery?.engine !== engine)) {
    throw new Error("지원하지 않거나 서로 다른 로컬 미디어 엔진입니다.");
  }
  if (analysis.type === "vimeo") await requireEmbeddedVideoHelper();
  if (analysis.batch && engine === "http-images") {
    const helper = await probeHelper();
    if (!helperSupportsVersion(helper.version, [0, 7, 2])) {
      throw new Error("작품 전체 다운로드에는 Media Helper 0.7.2 이상이 필요합니다. Helper를 다시 설치해 주세요.");
    }
  }
  if (engine === "youtube-transcripts") {
    const helper = await probeHelper();
    if (!helperSupportsVersion(helper.version, [0, 9, 0])) {
      throw new Error("재생목록 스크립트 다운로드에는 Media Helper 0.9.0 이상이 필요합니다. Helper를 다시 설치해 주세요.");
    }
  }

  const jobId = context.id || `${Date.now()}-${crypto.randomUUID()}`;
  const root = normalizeBrandRoot(requestedRoot);
  const total = engine === "http-images"
    ? nativeAssets.length
    : Math.max(1, Number(analysis.mediaCount || analysis.expectedCount) || 1);
  const job = {
    id: jobId,
    backend: "native",
    type: analysis.type,
    title: analysis.title,
    rangeLabel: analysis.rangeLabel || "",
    root,
    total,
    queued: 1,
    completed: 0,
    failed: 0,
    percent: 0,
    engine,
    quality: engine === "yt-dlp" ? options.quality || "best" : undefined,
    imageFormat: engine === "http-images" ? options.imageFormat || "original" : undefined,
    errors: [],
    status: "starting",
    sourceUrl: analysis.canonicalUrl || asset.delivery.pageUrl || "",
    queueKey: context.queueKey,
    queueManaged: Boolean(context.queueManaged),
    retrySpec: {
      analysis: {
        type: analysis.type,
        title: analysis.title,
        directoryTitle: analysis.directoryTitle,
        rangeLabel: analysis.rangeLabel || "",
        canonicalUrl: analysis.canonicalUrl || asset.delivery.pageUrl || "",
        mediaCount: total,
        expectedCount: total,
        batch: Boolean(analysis.batch),
        folders: Array.isArray(analysis.folders) ? analysis.folders : undefined,
        complete: true,
        assets: engine === "http-images" ? nativeAssets : [asset],
      },
      options: {
        quality: options.quality || "best",
        imageFormat: options.imageFormat || "original",
      },
    },
    createdAt: context.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await createJob(job);

  try {
    let started;
    if (engine === "http-images") {
      started = await helperRequest("POST", "/start-images", {
        jobId,
        root,
        title: analysis.directoryTitle || analysis.title,
        type: analysis.type,
        imageFormat: job.imageFormat,
        assets: nativeAssets.map((item) => ({
          url: item.url,
          filename: item.filename,
          folder: item.folder,
          referer: item.referer,
        })),
      }, 30000);
    } else if (engine === "youtube-transcripts") {
      started = await helperRequest("POST", "/start-transcripts", {
        jobId,
        root,
        title: analysis.title,
        url: asset.delivery.pageUrl,
        mediaCount: job.total,
      }, 30000);
    } else {
      started = await helperRequest("POST", "/start", {
        jobId,
        url: asset.delivery.pageUrl,
        referer: asset.delivery.referer,
        quality: job.quality,
        root,
        title: analysis.title,
        type: analysis.type,
        mediaCount: job.total,
        folders: Array.isArray(analysis.folders) ? analysis.folders : undefined,
      }, 30000);
    }
    await updateJob(jobId, (current) => ({
      ...current,
      outputDirectory: started.outputDirectory || current.outputDirectory,
    }));
  } catch (error) {
    const failed = await updateJob(jobId, (current) => ({
      ...current,
      failed: 1,
      status: "failed",
      errors: [...current.errors, error?.message || String(error)].slice(-20),
    }));
    throw new Error(failed.errors.at(-1));
  }
  chrome.alarms.create(`helper-job:${jobId}`, { periodInMinutes: 0.5 });
  beginHelperPolling(jobId);
  return (await storageGet(`job:${jobId}`))[`job:${jobId}`];
}

async function syncHelperJob(jobId) {
  let message;
  try {
    message = await helperRequest("GET", `/jobs/${encodeURIComponent(jobId)}`, undefined, 10000);
  } catch (error) {
    if (error?.status !== 404) throw error;
    const lost = await updateJob(jobId, (current) => ({
      ...current,
      failed: 1,
      status: "failed",
      errors: [...(current.errors || []), "Media Helper가 다시 시작되어 진행 작업을 복구하지 못했습니다. 재시도해 주세요."].slice(-20),
    }));
    chrome.alarms.clear(`helper-job:${jobId}`).catch(() => {});
    await pauseQueueIfPending();
    scheduleQueuePump();
    return lost;
  }
  const next = await updateJob(jobId, (current) => {
    const status = message.status || current.status;
    const helperErrors = [
      ...(Array.isArray(message.errors) ? message.errors : []),
      ...(message.error ? [message.error] : []),
    ];
    return {
      ...current,
      status,
      percent: Number.isFinite(Number(message.percent)) ? Number(message.percent) : current.percent,
      failed: Number.isFinite(Number(message.failedFiles))
        ? Number(message.failedFiles)
        : status === "failed" ? Math.max(1, current.failed) : current.failed,
      completed: Number.isFinite(Number(message.completedFiles))
        ? Number(message.completedFiles)
        : status === "completed" ? current.total : current.completed,
      filename: message.filename || current.filename,
      outputDirectory: message.outputDirectory || current.outputDirectory,
      mediaCount: message.mediaCount || current.mediaCount || current.total,
      currentItem: message.currentItem || current.currentItem,
      currentFolder: message.currentFolder || current.currentFolder,
      completedFiles: message.completedFiles ?? current.completedFiles,
      errors: helperErrors.length
        ? [...new Set([...(current.errors || []), ...helperErrors])].slice(-20)
        : current.errors,
    };
  });
  if (TERMINAL_STATUSES.has(next?.status)) {
    chrome.alarms.clear(`helper-job:${jobId}`).catch(() => {});
    scheduleQueuePump();
  }
  return next;
}

async function beginHelperPolling(jobId) {
  if (activeHelperPolls.has(jobId)) return;
  activeHelperPolls.add(jobId);
  try {
    while (true) {
      const job = await syncHelperJob(jobId);
      if (!job || TERMINAL_STATUSES.has(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch {
    // 30초 간격 alarm이 작업 상태 동기화를 다시 시도한다.
  } finally {
    activeHelperPolls.delete(jobId);
  }
}

function uniqueAssets(assets = []) {
  const seen = new Set();
  return assets.filter((asset) => {
    const key = `${asset?.url || ""}\n${asset?.filename || ""}`;
    if (!asset || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function cancelDownloadJob(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new Error("취소할 작업을 찾을 수 없습니다.");
  if (TERMINAL_STATUSES.has(job.status)) throw new Error("이미 종료된 작업입니다.");

  if (job.backend === "native") {
    await helperRequest("POST", "/cancel", { jobId }, 10000);
    chrome.alarms.clear(`helper-job:${jobId}`).catch(() => {});
  } else {
    const targets = await takeJobDownloadEntries(jobId);
    await Promise.all(targets.map(([downloadId]) => chrome.downloads.cancel(Number(downloadId)).catch(() => {})));
    job.failedAssets = uniqueAssets([
      ...(job.failedAssets || []),
      ...targets.map(([, entry]) => entry.asset).filter(Boolean),
    ]);
  }

  const canceled = await updateJob(jobId, (current) => ({
    ...current,
    failedAssets: job.failedAssets || current.failedAssets,
    status: "canceled",
    errors: [...(current.errors || []), "사용자가 작업을 취소했습니다."].slice(-20),
  }));
  await finishDirectJobIfNeeded(canceled);
  scheduleQueuePump();
  return canceled;
}

async function retryDownloadJob(jobId) {
  const job = await withJobLock(jobId, async () => {
    const key = `job:${jobId}`;
    const stored = await storageGet(key);
    const current = stored[key];
    if (!current) throw new Error("재시도할 작업을 찾을 수 없습니다.");
    if (!TERMINAL_STATUSES.has(current.status)) throw new Error("진행 중인 작업은 재시도할 수 없습니다.");
    if (current.retrying) throw new Error("이미 재시도를 시작하고 있습니다.");
    if (current.retriedBy) {
      const child = await getJob(current.retriedBy);
      if (child && !TERMINAL_STATUSES.has(child.status)) throw new Error("이 작업의 재시도가 이미 진행 중입니다.");
    }
    const claimed = { ...current, retrying: true, updatedAt: new Date().toISOString() };
    await storageSet({ [key]: claimed });
    return claimed;
  });

  try {
    let queued;
    if (job.backend === "native") {
      if (!job.retrySpec?.analysis) throw new Error("이 작업에는 재시도 정보가 없습니다.");
      queued = await enqueueDownloadJob(job.retrySpec.analysis, job.root, job.retrySpec.options || {});
    } else {
      const failedAssets = uniqueAssets(job.failedAssets || []);
      if (!failedAssets.length) throw new Error("재시도할 실패 항목이 없습니다.");
      const retryAnalysis = {
        type: job.type,
        title: job.title,
        rangeLabel: job.rangeLabel || "",
        canonicalUrl: job.sourceUrl,
        assets: failedAssets,
        expectedCount: failedAssets.length,
        complete: true,
      };
      queued = await enqueueDownloadJob(retryAnalysis, job.root, { imageFormat: "original" });
    }
    const child = queued.job;
    await updateJob(jobId, (current) => ({ ...current, retrying: false, retriedBy: child.id }));
    return child;
  } catch (error) {
    await updateJob(jobId, (current) => ({ ...current, retrying: false }));
    throw error;
  }
}

async function deleteDownloadHistory(jobId) {
  return withHistoryLock(async () => {
    const state = await storageGet(null);
    const history = Array.isArray(state[JOB_HISTORY_KEY]) ? state[JOB_HISTORY_KEY] : [];
    const requested = jobId
      ? [jobId]
      : history.filter((id) => TERMINAL_STATUSES.has(state[`job:${id}`]?.status));
    const removable = requested.filter((id) => TERMINAL_STATUSES.has(state[`job:${id}`]?.status));
    if (jobId && !removable.length) throw new Error("진행 중인 기록은 삭제할 수 없습니다.");
    const nextHistory = history.filter((id) => !removable.includes(id));
    if (removable.length) await storageRemove(removable.map((id) => `job:${id}`));
    await storageSet({
      [JOB_HISTORY_KEY]: nextHistory,
      lastJobId: nextHistory[0] || null,
    });
    return { removed: removable.length, jobs: nextHistory.map((id) => state[`job:${id}`]).filter(Boolean) };
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("helper-job:")) return;
  beginHelperPolling(alarm.name.slice("helper-job:".length));
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id) {
    suggest();
    return;
  }
  const requested = pendingFilenames.get(item.url) || pendingFilenames.get(item.finalUrl);
  if (!requested) {
    suggest();
    return;
  }
  pendingFilenames.delete(item.url);
  pendingFilenames.delete(item.finalUrl);
  suggest({ filename: requested, conflictAction: "uniquify" });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_DOWNLOAD") {
    enqueueDownloadJob(message.analysis, message.root, message.options)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "GET_DOWNLOAD_QUEUE") {
    getQueueState()
      .then((queue) => sendResponse({ ok: true, queue }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "MOVE_DOWNLOAD_QUEUE") {
    moveQueuedJob(message.jobId, message.direction)
      .then((queue) => sendResponse({ ok: true, queue }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "REMOVE_DOWNLOAD_QUEUE") {
    removeQueuedJob(message.jobId)
      .then((queue) => sendResponse({ ok: true, queue }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "SET_DOWNLOAD_QUEUE_PAUSED") {
    setQueuePaused(message.paused)
      .then((queue) => sendResponse({ ok: true, queue }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "PROBE_NATIVE_HELPER") {
    probeHelper()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "PROBE_NATIVE_MEDIA") {
    Promise.resolve()
      .then(() => message.referer ? requireEmbeddedVideoHelper() : undefined)
      .then(() => helperRequest("POST", "/probe", { url: message.url, referer: message.referer }, 120000))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "PROBE_CHANNEL") {
    helperRequest("POST", "/probe-channel", {
      url: message.url,
      limit: message.limit,
      offset: message.offset,
    }, 60000)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "PROBE_YOUTUBE_PLAYLIST") {
    probeHelper()
      .then((helper) => {
        if (!helperSupportsVersion(helper.version, [0, 9, 0])) {
          throw new Error("재생목록 스크립트 다운로드에는 Media Helper 0.9.0 이상이 필요합니다. Helper를 다시 설치해 주세요.");
        }
        return helperRequest("POST", "/probe-playlist", { url: message.url }, 120000);
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "OPEN_DOWNLOAD_FOLDER") {
    getJob(message.jobId)
      .then(async (job) => {
        if (!job) throw new Error("저장된 다운로드 작업을 찾을 수 없습니다.");
        if (job.backend !== "native") {
          if (!await showDirectDownload(job)) chrome.downloads.showDefaultFolder();
          sendResponse({ ok: true, path: job.relativeDirectory });
          return;
        }
        const data = await helperRequest("POST", "/open-folder", {
          outputDirectory: job.outputDirectory,
          relativeDirectory: job.relativeDirectory,
        }, 10000);
        sendResponse({ ok: true, path: data.path });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "GET_DOWNLOAD_HISTORY") {
    reconcileDownloadHistory()
      .then(getHistoryJobs)
      .then((jobs) => sendResponse({ ok: true, jobs }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "CANCEL_DOWNLOAD_JOB") {
    cancelDownloadJob(message.jobId)
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "RETRY_DOWNLOAD_JOB") {
    retryDownloadJob(message.jobId)
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "DELETE_DOWNLOAD_HISTORY") {
    const reconcile = message.jobId ? Promise.resolve() : reconcileDownloadHistory();
    reconcile
      .then(() => deleteDownloadHistory(message.jobId))
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "GET_EXTENSION_STATE") {
    storageGet(["downloadRoot", "lastJobId", "imageFormat"])
      .then(async (state) => {
        const root = normalizeBrandRoot(state.downloadRoot);
        if (root !== state.downloadRoot) await storageSet({ downloadRoot: root });
        const jobs = await getHistoryJobs();
        let job = jobs.find((candidate) => !TERMINAL_STATUSES.has(candidate.status) && candidate.status !== "waiting") || null;
        if (!job && state.lastJobId) {
          const last = (await storageGet(`job:${state.lastJobId}`))[`job:${state.lastJobId}`];
          if (last?.status !== "waiting") job = last;
        }
        if (job?.backend === "native" && !TERMINAL_STATUSES.has(job.status)) {
          try { job = await syncHelperJob(job.id); } catch { /* 저장된 마지막 상태를 표시한다. */ }
        }
        sendResponse({
          ok: true,
          root,
          imageFormat: new Set(["original", "webp"]).has(state.imageFormat) ? state.imageFormat : "original",
          job: job || null,
          queue: await getQueueState(),
        });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return undefined;
});

async function reconcileDirectDownload(downloadId, delta = {}, options = {}) {
  const [download] = await chrome.downloads.search({ id: Number(downloadId) });
  const missing = !download && options.missingAsInterrupted;
  const state = delta.state?.current || download?.state || (missing ? "interrupted" : undefined);
  const error = delta.error?.current || download?.error || (missing ? "DOWNLOAD_NOT_FOUND" : undefined);
  if (state !== "complete" && state !== "interrupted" && !error) return;
  const entry = await takeDownloadEntry(downloadId);
  if (!entry) return;

  if (state === "complete") {
    const actualName = download?.filename || "";
    const unexpectedMime = download?.mime && (
      (entry.asset?.kind === "image" && !/^image\//i.test(download.mime)) ||
      (entry.asset?.kind === "video" && !/^(?:video\/|application\/octet-stream)/i.test(download.mime))
    );
    const invalid = !download || download.fileSize <= 0 || /\.(?:html?|htm)$/i.test(actualName) || unexpectedMime;
    const nextJob = await updateJob(entry.jobId, (current) => ({
      ...current,
      completed: current.completed + (invalid ? 0 : 1),
      failed: current.failed + (invalid ? 1 : 0),
      failedAssets: invalid
        ? uniqueAssets([...(current.failedAssets || []), entry.asset].filter(Boolean))
        : current.failedAssets,
      errors: invalid
        ? [...current.errors, `#${entry.index + 1}: 이미지가 아닌 응답 또는 0바이트 파일`].slice(-20)
        : current.errors,
      status:
        current.completed + current.failed + 1 >= current.total
          ? current.failed + (invalid ? 1 : 0)
            ? "finished_with_errors"
            : "completed"
          : "downloading",
    }));
    await finishDirectJobIfNeeded(nextJob);
  } else {
    const nextJob = await updateJob(entry.jobId, (current) => {
      const detail = error || "interrupted";
      return {
        ...current,
        failed: current.failed + 1,
        failedAssets: uniqueAssets([...(current.failedAssets || []), entry.asset].filter(Boolean)),
        errors: [...current.errors, `#${entry.index + 1}: ${detail}`].slice(-20),
        status:
          current.completed + current.failed + 1 >= current.total
            ? "finished_with_errors"
            : "downloading",
      };
    });
    await finishDirectJobIfNeeded(nextJob);
  }
}

async function reconcileActiveDownloads(options = {}) {
  const stored = await storageGet(DOWNLOAD_MAP_KEY);
  const ids = Object.keys(stored[DOWNLOAD_MAP_KEY] || {});
  await Promise.all(ids.map((id) => reconcileDirectDownload(id, {}, options).catch(() => {})));
}

async function finalizeOrphanedDirectJobs() {
  const state = await storageGet(null);
  const history = Array.isArray(state[JOB_HISTORY_KEY]) ? state[JOB_HISTORY_KEY] : [];
  const mappedJobIds = new Set(
    Object.values(state[DOWNLOAD_MAP_KEY] || {}).map((entry) => entry?.jobId).filter(Boolean),
  );
  const now = Date.now();

  for (const jobId of history) {
    const job = state[`job:${jobId}`];
    if (!job || job.backend === "native" || job.backend === "queue" || job.status === "waiting" || TERMINAL_STATUSES.has(job.status) || mappedJobIds.has(jobId)) continue;
    const updatedAt = Date.parse(job.updatedAt || job.createdAt || "");
    if (Number.isFinite(updatedAt) && now - updatedAt < ORPHAN_JOB_GRACE_MS) continue;

    const next = await updateJob(jobId, (current) => {
      if (!current || current.backend === "native" || TERMINAL_STATUSES.has(current.status)) return current;
      const unresolved = Math.max(0, Number(current.total || 0) - Number(current.completed || 0) - Number(current.failed || 0));
      const failed = Number(current.failed || 0) + unresolved;
      return {
        ...current,
        failed,
        status: Number(current.completed || 0) > 0 ? "finished_with_errors" : "failed",
        errors: [
          ...(current.errors || []),
          "활성 다운로드 정보를 찾지 못해 중단된 작업으로 정리했습니다.",
        ].slice(-20),
      };
    });
    await finishDirectJobIfNeeded(next);
  }
}

async function reconcileDownloadHistory() {
  await reconcileActiveDownloads({ missingAsInterrupted: true });
  await finalizeOrphanedDirectJobs();
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state && !delta.error) return;
  await reconcileDirectDownload(delta.id, delta);
});

recoverClaimedQueueJobs()
  .then(reconcileDownloadHistory)
  .then(getHistoryJobs)
  .then((jobs) => {
    for (const job of jobs) {
      if (job.backend === "native" && !TERMINAL_STATUSES.has(job.status)) beginHelperPolling(job.id);
    }
    scheduleQueuePump();
  })
  .catch(() => {});
