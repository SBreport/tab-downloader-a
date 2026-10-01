const elements = {
  analyzeButton: document.querySelector("#analyzeButton"),
  instagramSelection: document.querySelector("#instagramSelection"),
  instagramItems: document.querySelector("#instagramItems"),
  downloadButton: document.querySelector("#downloadButton"),
  downloadBadge: document.querySelector("#downloadBadge"),
  resultCard: document.querySelector("#resultCard"),
  progressCard: document.querySelector("#progressCard"),
  nativeOptions: document.querySelector("#nativeOptions"),
  imageOptions: document.querySelector("#imageOptions"),
  tabTitle: document.querySelector("#tabTitle"),
  tabUrl: document.querySelector("#tabUrl"),
  siteBadge: document.querySelector("#siteBadge"),
  helperBadge: document.querySelector("#helperBadge"),
  titleInput: document.querySelector("#titleInput"),
  rootInput: document.querySelector("#rootInput"),
  qualitySelect: document.querySelector("#qualitySelect"),
  videoChoice: document.querySelector("#videoChoice"),
  videoSelect: document.querySelector("#videoSelect"),
  qualityHint: document.querySelector("#qualityHint"),
  imageFormatSelect: document.querySelector("#imageFormatSelect"),
  imageFormatHint: document.querySelector("#imageFormatHint"),
  assetCount: document.querySelector("#assetCount"),
  contentKind: document.querySelector("#contentKind"),
  backendName: document.querySelector("#backendName"),
  warningBox: document.querySelector("#warningBox"),
  pathPreview: document.querySelector("#pathPreview"),
  jobStatus: document.querySelector("#jobStatus"),
  jobProgress: document.querySelector("#jobProgress"),
  jobSummary: document.querySelector("#jobSummary"),
  jobLocation: document.querySelector("#jobLocation"),
  openFolderButton: document.querySelector("#openFolderButton"),
  cancelJobButton: document.querySelector("#cancelJobButton"),
  queueDetails: document.querySelector("#queueDetails"),
  queueCount: document.querySelector("#queueCount"),
  queueStateText: document.querySelector("#queueStateText"),
  queuePauseButton: document.querySelector("#queuePauseButton"),
  queueList: document.querySelector("#queueList"),
  refreshHistoryButton: document.querySelector("#refreshHistoryButton"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  historyToggleButton: document.querySelector("#historyToggleButton"),
  historyCount: document.querySelector("#historyCount"),
  historyList: document.querySelector("#historyList"),
  errorDetails: document.querySelector("#errorDetails"),
  errorText: document.querySelector("#errorText"),
  message: document.querySelector("#message"),
  channelCard: document.querySelector("#channelCard"),
  channelBadge: document.querySelector("#channelBadge"),
  channelSelectedCount: document.querySelector("#channelSelectedCount"),
  channelLoading: document.querySelector("#channelLoading"),
  channelLongformGroup: document.querySelector("#channelLongformGroup"),
  longformCountBadge: document.querySelector("#longformCountBadge"),
  longformSelectAllCheckbox: document.querySelector("#longformSelectAllCheckbox"),
  longformItemList: document.querySelector("#longformItemList"),
  longformMoreButton: document.querySelector("#longformMoreButton"),
  channelShortsGroup: document.querySelector("#channelShortsGroup"),
  shortsCountBadge: document.querySelector("#shortsCountBadge"),
  shortsSelectAllCheckbox: document.querySelector("#shortsSelectAllCheckbox"),
  shortsItemList: document.querySelector("#shortsItemList"),
  shortsMoreButton: document.querySelector("#shortsMoreButton"),
  playlistUrlInput: document.querySelector("#playlistUrlInput"),
  playlistProbeButton: document.querySelector("#playlistProbeButton"),
  playlistPreview: document.querySelector("#playlistPreview"),
  playlistBadge: document.querySelector("#playlistBadge"),
  playlistTitle: document.querySelector("#playlistTitle"),
  playlistSummary: document.querySelector("#playlistSummary"),
  helperInstallHelp: document.querySelector("#helperInstallHelp"),
};

let activeTab = null;
let analysis = null;
let catalog = null;
let analysisGeneration = 0;
let currentJob = null;
let historyJobs = [];
let historyRevision = 0;
let historyExpanded = false;
let queueItems = [];
let queuePaused = false;
let playlistAnalysis = null;
let downloadTarget = null;
let analysisDownloadReady = false;
let downloadActionBusy = false;

let channelOffset = 0;
let channelName = ""; // yt-dlp가 준 실제 채널명 — 저장 폴더명으로 사용
let channelLongform = [];
let channelShorts = [];
let channelHasMore = { longform: false, shorts: false };
const channelSelected = new Map(); // key: `${kind}:${id}` -> {id, url, title, kind}

const COLLAPSED_HISTORY_COUNT = 3;
const CHANNEL_PAGE_SIZE = 50;

const TERMINAL_STATUSES = new Set(["completed", "failed", "finished_with_errors", "canceled"]);
const JOB_STATUS_LABELS = {
  waiting: "대기",
  queuing: "등록 중",
  starting: "시작 중",
  downloading: "다운로드 중",
  merging: "영상·음성 병합 중",
  finalizing: "마무리 중",
  completed: "완료",
  failed: "실패",
  finished_with_errors: "일부 실패",
  canceled: "취소됨",
};

const MEDIA_KIND_LABELS = {
  image: "이미지",
  video: "영상",
  audio: "오디오",
};

const BUILT_IN_ASSET_HOST_SUFFIXES = [".twimg.com"];

function showMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.style.color = isError ? "#ff9e89" : "#aab6b8";
}

async function loadCatalog() {
  if (!catalog) {
    const response = await fetch(chrome.runtime.getURL("catalog/engine-catalog.json"));
    if (!response.ok) throw new Error("엔진 카탈로그를 읽지 못했습니다.");
    catalog = await response.json();
  }
  return catalog;
}

function hostMatches(hostname, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function findCatalogEntry(rawUrl, entries) {
  const url = new URL(rawUrl);
  return entries.find((entry) => {
    if (entry.urlRegex && !new RegExp(entry.urlRegex, "i").test(url.href)) return false;
    if (entry.hosts?.length && !entry.hosts.some((host) => hostMatches(url.hostname, host))) return false;
    if (entry.pathRegex && !new RegExp(entry.pathRegex, "i").test(`${url.pathname}${url.search}`)) return false;
    return Boolean(entry.urlRegex || entry.hosts?.length);
  }) || null;
}

function updatePathPreview() {
  if (!analysis) return;
  const root = elements.rootInput.value.trim() || "탭 다운로더 A";
  elements.pathPreview.textContent = `Downloads/${root}/${analysis.type}/${elements.titleInput.value || "제목"}/`;
}

function isNativeAnalysis(value = analysis) {
  return value?.backend === "native" || value?.assets?.some((asset) => asset.delivery?.mode === "native");
}

function nativeEngine(value = analysis) {
  return value?.assets?.find((asset) => asset.delivery?.mode === "native")?.delivery?.engine || "";
}

function isImageAnalysis(value = analysis) {
  return Boolean(value?.assets?.length) && value.assets.every((asset) => asset.kind === "image");
}

function selectedImageFormat() {
  return isImageAnalysis() ? elements.imageFormatSelect.value || "original" : "original";
}

function selectedRangeAnalysis(value = analysis) {
  if (value?.type === "instagram") {
    const indexes = new Set([...elements.instagramItems.querySelectorAll("input:checked")].map((input) => Number(input.value)));
    const assets = value.assets.filter((_asset, index) => indexes.has(index));
    return { ...value, assets, mediaCount: assets.length, expectedCount: assets.length };
  }
  return value;
}

function analysisDownloadLabel() {
  if (!analysis || analysis.kind === "channel-listing") return "현재 탭을 분석해 주세요";
  const selected = selectedRangeAnalysis();
  if (analysis.type === "instagram") return selected.assets.length ? `선택한 미디어 ${selected.assets.length}개 다운로드` : "저장할 사진·영상을 선택해 주세요";
  const count = Math.max(1, Number(selected.mediaCount || selected.expectedCount) || selected.assets?.length || 1);
  if (isImageAnalysis(selected)) return `이미지 ${count}개 다운로드`;
  const kind = selected.assets?.[0]?.kind;
  return `${MEDIA_KIND_LABELS[kind] || "미디어"} ${count}개 다운로드`;
}

function restoreAnalysisDownloadTarget() {
  if (analysis?.kind === "channel-listing") downloadTarget = "channel";
  else if (analysis) downloadTarget = "analysis";
  else downloadTarget = null;
  updateDownloadAction();
}

function setDownloadTarget(target, ready = false) {
  downloadTarget = target;
  if (target === "analysis") analysisDownloadReady = ready;
  updateDownloadAction();
}

function setDownloadActionBusy(busy) {
  downloadActionBusy = busy;
  updateDownloadAction();
}

function updateDownloadAction() {
  const activeJob = currentJob && !TERMINAL_STATUSES.has(currentJob.status);
  let label = "현재 탭을 분석해 주세요";
  let badge = "준비 전";
  let ready = false;

  if (downloadTarget === "analysis" && analysis) {
    label = analysisDownloadLabel();
    badge = analysisDownloadReady ? "준비 완료" : "확인 중";
    ready = analysisDownloadReady && (analysis.type !== "instagram" || selectedRangeAnalysis().assets.length > 0);
  } else if (downloadTarget === "playlist" && playlistAnalysis) {
    const count = Number(playlistAnalysis.mediaCount) || 0;
    label = `스크립트 ${count}개 다운로드`;
    badge = "재생목록";
    ready = true;
  } else if (downloadTarget === "channel") {
    const count = channelSelected.size;
    label = count ? `선택한 영상 ${count}개 다운로드` : "다운로드할 영상을 선택해 주세요";
    badge = "채널 영상";
    ready = count > 0;
  }

  if (activeJob) {
    if (ready) {
      badge = queueItems.length ? `대기 ${queueItems.length}` : "대기열 추가";
    } else {
      label = "다운로드 진행 중";
      badge = JOB_STATUS_LABELS[currentJob.status] || currentJob.status;
    }
  }
  elements.downloadButton.textContent = label;
  elements.downloadBadge.textContent = badge;
  elements.downloadButton.disabled = downloadActionBusy || !ready;
}

function updateImageFormatUi() {
  const webp = selectedImageFormat() === "webp";
  elements.imageFormatHint.textContent = webp
    ? "PNG·JPEG → 무손실 WebP"
    : "원본 그대로 저장";
  if (analysis) elements.backendName.textContent = webp ? "Helper · WebP" : isNativeAnalysis() ? "Helper" : "Chrome";
}

function setQualityOptions(qualities = []) {
  elements.qualitySelect.replaceChildren();
  for (const quality of qualities) {
    const option = document.createElement("option");
    option.value = quality.value;
    option.textContent = quality.label;
    elements.qualitySelect.append(option);
  }
}

async function prepareNativeOptions(value, generation) {
  elements.nativeOptions.classList.remove("hidden");
  elements.helperBadge.textContent = "확인 중";
  elements.qualitySelect.disabled = true;
  setQualityOptions([{ value: "best", label: "품질 목록 확인 중…" }]);
  elements.qualityHint.textContent = "게시물이 제공하는 실제 영상 포맷을 확인하고 있습니다.";

  const helper = await chrome.runtime.sendMessage({ type: "PROBE_NATIVE_HELPER" });
  if (generation !== analysisGeneration) return;
  if (!helper?.ok) throw new Error(`Media Helper 연결 실패: ${helper?.error || "설치 상태를 확인하세요."}`);
  elements.helperBadge.textContent = "연결됨";

  const asset = value.assets.find((candidate) => candidate.delivery?.mode === "native");
  const probe = await chrome.runtime.sendMessage({
    type: "PROBE_NATIVE_MEDIA",
    url: asset?.delivery?.pageUrl,
    referer: asset?.delivery?.referer,
  });
  if (generation !== analysisGeneration) return;
  if (!probe?.ok) throw new Error(`영상 품질 분석 실패: ${probe?.error || "알 수 없는 오류"}`);

  const qualities = Array.isArray(probe.data?.qualities) && probe.data.qualities.length
    ? probe.data.qualities
    : [{ value: "best", label: "최고 화질" }];
  setQualityOptions(qualities);
  elements.qualitySelect.disabled = false;
  const mediaCount = Math.max(1, Number(probe.data?.mediaCount || value.mediaCount || value.expectedCount) || 1);
  analysis.mediaCount = mediaCount;
  analysis.expectedCount = mediaCount;
  elements.assetCount.textContent = String(mediaCount);
  elements.contentKind.textContent = mediaCount > 1 ? `video × ${mediaCount}` : "video";
  elements.qualityHint.textContent = mediaCount > 1
    ? `이 게시물에는 서로 다른 영상이 ${mediaCount}개 있습니다. 각 영상마다 선택 화질의 최종 MP4 한 개씩 저장합니다.`
    : "선택 화질의 최종 MP4 한 개만 저장합니다. 분리된 영상·음성은 병합 후 임시 파일을 제거합니다.";
  if (probe.data?.title && value.type === "youtube") {
    analysis.title = probe.data.title;
    elements.titleInput.value = probe.data.title;
    updatePathPreview();
  }
  analysisDownloadReady = Boolean(value.complete);
  updateDownloadAction();
}

function renderAnalysis(value) {
  analysis = value;
  analysisDownloadReady = false;
  elements.instagramSelection.classList.toggle("hidden", value.type !== "instagram");
  elements.instagramItems.replaceChildren();
  if (value.type === "instagram") value.assets.forEach((asset, index) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(index);
    input.checked = true;
    input.addEventListener("change", updateDownloadAction);
    label.append(input, ` ${asset.filename} · ${asset.kind === "video" ? "영상" : "사진"}`);
    elements.instagramItems.append(label);
  });
  if (value.kind === "channel-listing") {
    elements.resultCard.classList.add("hidden");
    setDownloadTarget("channel");
    renderChannelListing(value);
    return;
  }
  elements.videoChoice.classList.toggle("hidden", !value.videoCandidates || value.videoCandidates.length < 2);
  elements.videoSelect.replaceChildren(...(value.videoCandidates || []).map((asset, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `영상 ${index + 1} · Vimeo ${asset.id}`;
    return option;
  }));
  elements.channelCard.classList.add("hidden");
  elements.warningBox.before(elements.nativeOptions); // 채널 모드에서 빌려간 품질 select를 resultCard 원래 자리로 복귀
  const kinds = [...new Set(value.assets.map((asset) => asset.kind))];
  const mediaCount = Math.max(1, Number(value.mediaCount || value.expectedCount) || value.assets.length);
  elements.siteBadge.textContent = value.siteName;
  elements.titleInput.value = value.title;
  elements.assetCount.textContent = String(mediaCount);
  const kindText = kinds.map((kind) => MEDIA_KIND_LABELS[kind] || kind).join(" + ") || "-";
  elements.contentKind.textContent = kindText;
  elements.imageOptions.classList.toggle("hidden", !isImageAnalysis(value));
  updateImageFormatUi();
  elements.resultCard.classList.remove("hidden");
  elements.nativeOptions.classList.toggle("hidden", nativeEngine(value) !== "yt-dlp");
  elements.warningBox.textContent = (value.warnings || []).join("\n");
  elements.warningBox.classList.toggle("hidden", !value.warnings?.length);
  setDownloadTarget("analysis", false);
  elements.analyzeButton.textContent = "현재 탭 다시 분석";
  updatePathPreview();
}

function channelItemKey(kind, id) {
  return `${kind}:${id}`;
}

function updateChannelDownloadButton() {
  const count = channelSelected.size;
  elements.channelSelectedCount.textContent = `${count}개 선택`;
  if (downloadTarget === "channel") updateDownloadAction();
}

function renderChannelGroup(kind, items, listEl, countEl, selectAllEl, moreButtonEl, groupEl) {
  groupEl.classList.toggle("hidden", items.length === 0);
  if (!items.length) return;
  countEl.textContent = String(items.length);
  listEl.replaceChildren();
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "history-item channel-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "channel-item-check";
    checkbox.dataset.kind = kind;
    checkbox.dataset.id = item.id;
    checkbox.checked = channelSelected.has(channelItemKey(kind, item.id));
    const thumb = document.createElement("img");
    thumb.className = "channel-thumb";
    thumb.loading = "lazy";
    thumb.src = `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
    thumb.alt = "";
    const info = document.createElement("div");
    info.className = "channel-item-info";
    const title = document.createElement("p");
    title.className = "history-title";
    title.textContent = item.title || "제목 없음";
    title.title = item.title || "";
    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = item.duration == null ? "" : `${Math.floor(item.duration / 60)}:${String(Math.round(item.duration) % 60).padStart(2, "0")}`; // ponytail: 인라인 m:ss 포맷
    info.append(title, meta);
    row.append(checkbox, thumb, info);
    listEl.append(row);
  }
  selectAllEl.checked = items.every((item) => channelSelected.has(channelItemKey(kind, item.id)));
  moreButtonEl.classList.toggle("hidden", !channelHasMore[kind]);
}

function renderChannelLists() {
  renderChannelGroup(
    "longform", channelLongform, elements.longformItemList, elements.longformCountBadge,
    elements.longformSelectAllCheckbox, elements.longformMoreButton, elements.channelLongformGroup,
  );
  renderChannelGroup(
    "shorts", channelShorts, elements.shortsItemList, elements.shortsCountBadge,
    elements.shortsSelectAllCheckbox, elements.shortsMoreButton, elements.channelShortsGroup,
  );
  updateChannelDownloadButton();
}

async function fetchChannelPage(url, offset) {
  const response = await chrome.runtime.sendMessage({ type: "PROBE_CHANNEL", url, limit: CHANNEL_PAGE_SIZE, offset });
  if (!response?.ok) throw new Error(response?.error || "채널 목록을 불러오지 못했습니다.");
  return response.data || {};
}

function dedupChannelAppend(list, incoming = []) {
  const seen = new Set(list.map((item) => item.id));
  return [...list, ...incoming.filter((item) => !seen.has(item.id))];
}

async function loadChannelMore() {
  const nextOffset = channelOffset + CHANNEL_PAGE_SIZE;
  try {
    const data = await fetchChannelPage(analysis.channel.url, nextOffset);
    channelOffset = nextOffset;
    channelLongform = dedupChannelAppend(channelLongform, data.longform);
    channelShorts = dedupChannelAppend(channelShorts, data.shorts);
    channelHasMore = data.hasMore || { longform: false, shorts: false };
    renderChannelLists();
  } catch (error) {
    showMessage(error?.message || String(error), true);
  }
}

async function renderChannelListing(value) {
  elements.videoChoice.classList.add("hidden");
  channelOffset = 0;
  channelName = value.channel?.name || "채널";
  channelLongform = [];
  channelShorts = [];
  channelHasMore = { longform: false, shorts: false };
  channelSelected.clear();
  setDownloadTarget("channel");
  elements.channelCard.classList.remove("hidden");
  elements.channelBadge.textContent = channelName;
  elements.channelLoading.classList.remove("hidden");
  elements.channelLongformGroup.classList.add("hidden");
  elements.channelShortsGroup.classList.add("hidden");
  renderChannelLists();

  elements.channelLoading.after(elements.nativeOptions); // 채널 모드: 기존 품질 select를 그대로 빌려온다
  elements.nativeOptions.classList.remove("hidden");
  elements.helperBadge.textContent = "채널 모드";
  // ponytail: 채널 항목별 실제 화질 목록은 Phase 4(다운로드 배선)에서 조회한다. 지금은 자리만 재사용.
  setQualityOptions([{ value: "best", label: "최고 화질" }]);
  elements.qualitySelect.disabled = false;
  elements.qualityHint.textContent = "선택한 영상 다운로드 시 사용할 화질입니다.";

  try {
    const data = await fetchChannelPage(value.channel.url, 0);
    if (data.channelName) {
      channelName = data.channelName;
      elements.channelBadge.textContent = channelName;
    }
    channelLongform = data.longform || [];
    channelShorts = data.shorts || [];
    channelHasMore = data.hasMore || { longform: false, shorts: false };
    renderChannelLists();
    showMessage(`롱폼 ${channelLongform.length}개 · 숏폼 ${channelShorts.length}개를 찾았습니다.`);
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    elements.channelLoading.classList.add("hidden");
  }
}

async function handleChannelDownload(selected, channelName) {
  if (!selected.length) return;
  setDownloadActionBusy(true);
  const quality = elements.qualitySelect.value || "best";
  const root = elements.rootInput.value;
  showMessage(`Media Helper에 ${selected.length}개 영상 작업을 전달하고 있습니다…`);
  let started = 0;
  const failures = [];
  // 선택한 영상마다 단일 영상 작업을 등록하고 service worker가 순서대로 실행한다.
  for (const video of selected) {
    const label = video.title || video.id;
    const one = {
      type: "youtube",
      siteName: "YouTube",
      backend: "native",
      title: label,
      canonicalUrl: video.url,
      mediaCount: 1,
      expectedCount: 1,
      complete: true,
      // 채널명/구분(shorts·videos) 하위 폴더로 묶어 저장: youtube/채널명/shorts/영상 [id].mp4
      folders: [channelName || "채널", video.kind === "shorts" ? "shorts" : "videos"],
      assets: [{
        id: video.id,
        kind: "video",
        filename: `${label}.mp4`,
        delivery: { mode: "native", engine: "yt-dlp", pageUrl: video.url },
      }],
    };
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        analysis: one,
        root,
        options: { quality, imageFormat: "original" },
      });
      if (!response?.ok) throw new Error(response?.error || "작업을 시작하지 못했습니다.");
      if (response.queue) renderQueue(response.queue);
      upsertHistoryJob(response.job);
      if (response.job?.status !== "waiting") renderJob(response.job);
      started += 1;
    } catch (error) {
      failures.push(`${label}: ${error?.message || String(error)}`);
    }
  }
  const where = channelName ? `${channelName} ` : "";
  showMessage(
    failures.length
      ? `${where}영상 ${started}개 등록, ${failures.length}개 실패: ${failures[0]}`
      : `${where}영상 ${started}개를 순차 다운로드에 등록했습니다. 패널을 닫아도 작업은 계속됩니다.`,
    failures.length > 0,
  );
  setDownloadActionBusy(false);
  updateChannelDownloadButton();
}

function renderJob(job) {
  if (!job || job.status === "waiting") return;
  if (currentJob) {
    const currentTime = Date.parse(currentJob.updatedAt || currentJob.createdAt || 0) || 0;
    const nextTime = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
    if (currentJob.id === job.id && nextTime < currentTime) return;
    if (currentJob.id !== job.id && !TERMINAL_STATUSES.has(currentJob.status)) {
      const currentCreated = Date.parse(currentJob.createdAt || 0) || 0;
      const nextCreated = Date.parse(job.createdAt || 0) || 0;
      if (nextCreated < currentCreated) return;
    }
  }
  currentJob = job;
  elements.progressCard.classList.remove("hidden");
  elements.jobStatus.textContent = JOB_STATUS_LABELS[job.status] || job.status;
  if (job.backend === "native") {
    elements.jobProgress.max = 100;
    elements.jobProgress.value = Math.max(0, Math.min(100, Number(job.percent) || 0));
    if (job.engine === "http-images") {
      const format = job.imageFormat === "webp" ? " · 형식 WebP" : "";
      const folder = job.currentFolder ? ` · ${job.currentFolder}` : "";
      elements.jobSummary.textContent = `완료 ${job.completed || 0} · 실패 ${job.failed || 0} · 전체 ${job.total || 0}${folder}${format}`;
    } else if (job.engine === "youtube-transcripts") {
      const itemCount = Number(job.mediaCount || job.total) || 1;
      const item = Math.min(itemCount, Number(job.currentItem) || 0);
      elements.jobSummary.textContent = `TXT 완료 ${job.completed || 0} · 실패 ${job.failed || 0} · 항목 ${item}/${itemCount}`;
    } else {
      const suffix = job.outputDirectory ? ` · ${job.outputDirectory}` : "";
      const itemCount = Number(job.mediaCount || job.total) || 1;
      const item = Math.min(itemCount, Number(job.currentItem || job.completedFiles) || 0);
      const itemText = itemCount > 1 ? ` · 항목 ${item}/${itemCount}` : "";
      elements.jobSummary.textContent = `${Math.round(Number(job.percent) || 0)}%${itemText} · 품질 ${job.quality || "best"}${suffix}`;
    }
  } else {
    const done = job.completed + job.failed;
    elements.jobProgress.max = Math.max(job.total, 1);
    elements.jobProgress.value = done;
    elements.jobSummary.textContent = `완료 ${job.completed} · 실패 ${job.failed} · 등록 ${job.queued}/${job.total}`;
  }
  const hasErrors = Boolean(job.errors?.length);
  elements.errorDetails.classList.toggle("hidden", !hasErrors);
  elements.errorText.textContent = hasErrors ? job.errors.join("\n") : "";
  elements.jobLocation.textContent = job.outputDirectory ||
    (job.relativeDirectory ? `Downloads/${job.relativeDirectory}` : "");
  elements.openFolderButton.disabled = !(job.id && (job.outputDirectory || job.relativeDirectory));
  elements.cancelJobButton.classList.toggle("hidden", TERMINAL_STATUSES.has(job.status));
  elements.cancelJobButton.disabled = TERMINAL_STATUSES.has(job.status);
  updateDownloadAction();
}

function jobLocation(job) {
  return job.outputDirectory || (job.relativeDirectory ? `Downloads/${job.relativeDirectory}` : "");
}

function upsertHistoryJob(job) {
  if (!job?.id) return;
  const existing = historyJobs.find((item) => item.id === job.id);
  const existingTime = Date.parse(existing?.updatedAt || existing?.createdAt || 0) || 0;
  const nextTime = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
  if (existing && nextTime < existingTime) return;
  historyRevision += 1;
  historyJobs = [job, ...historyJobs.filter((item) => item.id !== job.id)]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 50);
  renderHistory();
}

function makeHistoryAction(label, action, jobId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.jobId = jobId;
  return button;
}

function renderQueue(queue = {}) {
  queueItems = Array.isArray(queue.items) ? queue.items : [];
  queuePaused = Boolean(queue.paused);
  elements.queueCount.textContent = String(queueItems.length);
  elements.queueStateText.textContent = queuePaused ? "일시정지" : queueItems.length ? `${queueItems.length}개 대기` : "비어 있음";
  elements.queuePauseButton.textContent = queuePaused ? "다음 작업 계속" : "다음 작업 일시정지";
  elements.queueList.replaceChildren();

  if (!queueItems.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "대기 중인 작업이 없습니다.";
    elements.queueList.append(empty);
  }

  queueItems.forEach((job, index) => {
    const item = document.createElement("article");
    item.className = "history-item";
    const title = document.createElement("p");
    title.className = "history-title";
    title.textContent = `${index + 1}. ${[job.title || job.type || "이름 없는 작업", job.rangeLabel].filter(Boolean).join(" · ")}`;
    title.title = title.textContent;
    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = `${job.type} · ${job.total || 1}개`;
    const actions = document.createElement("div");
    actions.className = "history-actions queue-actions";
    const addAction = (label, action, disabled = false) => {
      const button = makeHistoryAction(label, action, job.id);
      button.disabled = disabled;
      actions.append(button);
    };
    addAction("↑", "queue-up", index === 0);
    addAction("↓", "queue-down", index === queueItems.length - 1);
    addAction("제거", "queue-remove");
    item.append(title, meta, actions);
    elements.queueList.append(item);
  });
  updateDownloadAction();
}

async function handleQueueAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, jobId } = button.dataset;
  const type = action === "queue-remove" ? "REMOVE_DOWNLOAD_QUEUE" : "MOVE_DOWNLOAD_QUEUE";
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type,
      jobId,
      direction: action === "queue-up" ? "up" : "down",
    });
    if (!response?.ok) throw new Error(response?.error || "대기열을 변경하지 못했습니다.");
    renderQueue(response.queue);
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

function applyStartedJob(response, startedMessage, queuedMessage = "대기열에 추가했습니다.") {
  if (response.queue) renderQueue(response.queue);
  upsertHistoryJob(response.job);
  if (response.job?.status === "waiting") {
    elements.queueDetails.open = true;
    showMessage(queuedMessage);
    return false;
  }
  renderJob(response.job);
  showMessage(startedMessage);
  return true;
}

function renderHistory() {
  const completedJobs = historyJobs.filter((job) => job.status !== "waiting");
  elements.historyList.replaceChildren();
  elements.historyCount.textContent = String(completedJobs.length);
  if (!completedJobs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "다운로드 기록이 없습니다.";
    elements.historyList.append(empty);
    elements.clearHistoryButton.disabled = true;
    elements.historyToggleButton.classList.add("hidden");
    return;
  }

  const visibleJobs = historyExpanded ? completedJobs : completedJobs.slice(0, COLLAPSED_HISTORY_COUNT);
  for (const job of visibleJobs) {
    const item = document.createElement("article");
    item.className = "history-item";
    const title = document.createElement("p");
    title.className = "history-title";
    title.textContent = [job.title || job.type || "이름 없는 작업", job.rangeLabel].filter(Boolean).join(" · ");
    title.title = title.textContent;
    const meta = document.createElement("p");
    meta.className = "history-meta";
    const date = job.createdAt
      ? new Intl.DateTimeFormat("ko-KR", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(job.createdAt))
      : "시간 미상";
    const progress = job.backend === "native"
      ? `${Math.round(Number(job.percent) || 0)}%`
      : `${Number(job.completed) || 0}/${Number(job.total) || 0}`;
    meta.textContent = `${JOB_STATUS_LABELS[job.status] || job.status} · ${job.type} · ${progress} · ${date}`;
    item.append(title, meta);

    const location = jobLocation(job);
    if (location) {
      item.title = location;
    }

    const actions = document.createElement("div");
    actions.className = "history-actions";
    if (location) actions.append(makeHistoryAction("폴더 열기", "open", job.id));
    if (!TERMINAL_STATUSES.has(job.status)) actions.append(makeHistoryAction("취소", "cancel", job.id));
    const retryChild = job.retriedBy ? historyJobs.find((candidate) => candidate.id === job.retriedBy) : null;
    const retryBusy = job.retrying || (retryChild && !TERMINAL_STATUSES.has(retryChild.status));
    const canRetry = !retryBusy && (job.backend === "native" ? Boolean(job.retrySpec) : Boolean(job.failedAssets?.length));
    if (TERMINAL_STATUSES.has(job.status) && canRetry) actions.append(makeHistoryAction("재시도", "retry", job.id));
    if (TERMINAL_STATUSES.has(job.status)) actions.append(makeHistoryAction("삭제", "delete", job.id));
    if (actions.childElementCount) item.append(actions);
    elements.historyList.append(item);
  }
  elements.clearHistoryButton.disabled = !historyJobs.some((job) => TERMINAL_STATUSES.has(job.status));
  elements.historyToggleButton.classList.toggle("hidden", completedJobs.length <= COLLAPSED_HISTORY_COUNT);
  elements.historyToggleButton.textContent = historyExpanded
    ? "접기"
    : `더보기 (${completedJobs.length - COLLAPSED_HISTORY_COUNT})`;
}

async function openJobFolder(jobId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_DOWNLOAD_FOLDER",
      jobId,
    });
    if (!response?.ok) throw new Error(response?.error || "다운로드 폴더를 열지 못했습니다.");
    showMessage(`폴더를 열었습니다: ${response.path}`);
  } catch (error) {
    showMessage(error?.message || String(error), true);
  }
}

async function openDownloadFolder() {
  if (!currentJob?.id) return;
  elements.openFolderButton.disabled = true;
  await openJobFolder(currentJob.id);
  elements.openFolderButton.disabled = !(currentJob.outputDirectory || currentJob.relativeDirectory);
}

async function loadHistory() {
  const requestedRevision = historyRevision;
  elements.refreshHistoryButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_DOWNLOAD_HISTORY" });
    if (!response?.ok) throw new Error(response?.error || "다운로드 기록을 불러오지 못했습니다.");
    const incoming = Array.isArray(response.jobs) ? response.jobs : [];
    if (historyRevision === requestedRevision) {
      historyJobs = incoming;
    } else {
      const merged = new Map(incoming.map((job) => [job.id, job]));
      for (const job of historyJobs) {
        const other = merged.get(job.id);
        const jobTime = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
        const otherTime = Date.parse(other?.updatedAt || other?.createdAt || 0) || 0;
        if (!other || jobTime >= otherTime) merged.set(job.id, job);
      }
      historyJobs = [...merged.values()]
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, 50);
    }
    renderHistory();
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    elements.refreshHistoryButton.disabled = false;
  }
}

async function handleHistoryAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, jobId } = button.dataset;
  button.disabled = true;
  try {
    if (action === "open") return await openJobFolder(jobId);
    const messageType = {
      cancel: "CANCEL_DOWNLOAD_JOB",
      retry: "RETRY_DOWNLOAD_JOB",
      delete: "DELETE_DOWNLOAD_HISTORY",
    }[action];
    const response = await chrome.runtime.sendMessage({ type: messageType, jobId });
    if (!response?.ok) throw new Error(response?.error || "기록 작업을 처리하지 못했습니다.");
    if (action === "delete") {
      historyRevision += 1;
      historyJobs = Array.isArray(response.jobs) ? response.jobs : historyJobs.filter((job) => job.id !== jobId);
      if (currentJob?.id === jobId) {
        currentJob = null;
        elements.progressCard.classList.add("hidden");
      }
      renderHistory();
      showMessage("다운로드 기록만 삭제했습니다. 받은 파일은 그대로 유지됩니다.");
    } else {
      renderJob(response.job);
      upsertHistoryJob(response.job);
      showMessage(action === "cancel"
        ? "작업을 취소했습니다."
        : response.job?.status === "waiting" ? "재시도 작업을 대기열에 추가했습니다." : "실패 항목 재시도를 시작했습니다.");
    }
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

async function clearFinishedHistory() {
  elements.clearHistoryButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "DELETE_DOWNLOAD_HISTORY" });
    if (!response?.ok) throw new Error(response?.error || "완료 기록을 지우지 못했습니다.");
    historyRevision += 1;
    historyJobs = Array.isArray(response.jobs) ? response.jobs : [];
    if (currentJob && !historyJobs.some((job) => job.id === currentJob.id)) {
      currentJob = null;
      elements.progressCard.classList.add("hidden");
    }
    renderHistory();
    showMessage(`${response.removed || 0}개 기록을 삭제했습니다. 받은 파일은 그대로 유지됩니다.`);
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    elements.clearHistoryButton.disabled = !historyJobs.some((job) => TERMINAL_STATUSES.has(job.status));
  }
}

async function refreshActiveTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || "")) {
    const activeTabs = await chrome.tabs.query({ active: true });
    tab = activeTabs.find((candidate) => /^https?:/i.test(candidate.url || "")) || activeTabs[0];
  }
  activeTab = tab || null;
  elements.tabTitle.textContent = tab?.title || "현재 탭 없음";
  elements.tabTitle.title = [tab?.title, tab?.url].filter(Boolean).join("\n");
  elements.tabUrl.textContent = tab?.url || "";
  if (!elements.playlistUrlInput.value && /[?&]list=/.test(tab?.url || "")) {
    elements.playlistUrlInput.value = tab.url;
  }
}

function resetPlaylistPreview() {
  playlistAnalysis = null;
  elements.playlistPreview.classList.add("hidden");
  elements.playlistBadge.textContent = "최대 100개";
  elements.helperInstallHelp.classList.add("hidden");
  if (downloadTarget === "playlist") restoreAnalysisDownloadTarget();
}

async function probePlaylist() {
  const url = elements.playlistUrlInput.value.trim();
  resetPlaylistPreview();
  elements.playlistProbeButton.disabled = true;
  elements.playlistBadge.textContent = "확인 중";
  showMessage("Media Helper에서 재생목록을 확인하고 있습니다…");
  try {
    if (!url) throw new Error("YouTube 재생목록 링크를 입력해 주세요.");
    const response = await chrome.runtime.sendMessage({ type: "PROBE_YOUTUBE_PLAYLIST", url });
    if (!response?.ok) throw new Error(response?.error || "재생목록을 확인하지 못했습니다.");
    const value = response.data;
    playlistAnalysis = {
      type: "youtube_playlist_transcript",
      siteName: "YouTube",
      backend: "native",
      title: value.title,
      canonicalUrl: value.url,
      mediaCount: value.count,
      expectedCount: value.count,
      complete: true,
      assets: [{
        id: new URL(value.url).searchParams.get("list"),
        kind: "document",
        filename: value.title,
        delivery: { mode: "native", engine: "youtube-transcripts", pageUrl: value.url },
      }],
    };
    const first = value.entries?.[0]?.title;
    elements.playlistTitle.textContent = value.title;
    elements.playlistTitle.title = value.title;
    elements.playlistSummary.textContent = `${value.count}개 영상${first ? ` · 첫 영상: ${first}` : ""}`;
    elements.playlistBadge.textContent = `${value.count}개`;
    elements.playlistPreview.classList.remove("hidden");
    elements.helperInstallHelp.classList.add("hidden");
    setDownloadTarget("playlist", true);
    showMessage("재생목록 스크립트를 일괄 다운로드할 준비가 됐습니다.");
  } catch (error) {
    elements.playlistBadge.textContent = "확인 실패";
    elements.helperInstallHelp.classList.toggle("hidden", !/helper|0\.9\.0|연결|설치/i.test(error?.message || ""));
    showMessage(error?.message || String(error), true);
  } finally {
    elements.playlistProbeButton.disabled = false;
  }
}

async function startPlaylistTranscripts() {
  if (!playlistAnalysis) return;
  setDownloadActionBusy(true);
  showMessage("Media Helper에 재생목록 스크립트 작업을 전달하고 있습니다…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD",
      analysis: playlistAnalysis,
      root: elements.rootInput.value,
      options: {},
    });
    if (!response?.ok) throw new Error(response?.error || "스크립트 작업을 시작하지 못했습니다.");
    applyStartedJob(
      response,
      "스크립트 일괄 다운로드를 시작했습니다. 패널을 닫아도 작업은 계속됩니다.",
      "스크립트 작업을 대기열에 추가했습니다.",
    );
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    setDownloadActionBusy(false);
  }
}

async function ensureSitePermission(tab) {
  const url = new URL(tab.url);
  const originPattern = `${url.protocol}//${url.host}/*`;
  const permissions = { origins: [originPattern] };
  if (await chrome.permissions.contains(permissions)) return;
  showMessage(`${url.hostname} 탭 분석 권한을 승인해 주세요.`);
  const granted = await chrome.permissions.request(permissions);
  if (!granted) throw new Error(`${url.hostname} 분석 권한이 승인되지 않았습니다.`);
}

async function ensureDirectAssetPermissions(assets) {
  const origins = [...new Set(assets.filter((asset) => asset.url).map((asset) => {
    const url = new URL(asset.url);
    const builtIn = url.protocol === "https:" && BUILT_IN_ASSET_HOST_SUFFIXES.some(
      (suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix),
    );
    return builtIn ? null : `${url.protocol}//${url.host}/*`;
  }).filter(Boolean))];
  const missing = [];
  for (const origin of origins) {
    if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
  }
  if (!missing.length) return;
  showMessage("미디어 CDN 다운로드 권한을 승인해 주세요.");
  const granted = await chrome.permissions.request({ origins: missing });
  if (!granted) throw new Error("미디어 CDN 다운로드 권한이 승인되지 않았습니다.");
}

async function analyzeCurrentTab() {
  const generation = ++analysisGeneration;
  elements.analyzeButton.disabled = true;
  setDownloadTarget("analysis", false);
  showMessage("현재 탭에 맞는 엔진을 찾고 있습니다…");
  try {
    await refreshActiveTab();
    if (!activeTab?.id || !/^https?:/i.test(activeTab.url || "")) {
      throw new Error("일반 웹페이지 탭에서 실행해 주세요.");
    }
    const entry = findCatalogEntry(activeTab.url, await loadCatalog());
    elements.siteBadge.textContent = entry?.name || "페이지 내 영상";

    await ensureSitePermission(activeTab);
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["content/adapter-runtime.js", ...(entry?.adapterScript ? [entry.adapterScript] : []), "content/adapters/embedded-video.js", "content/analyzer.js"],
    });
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: "ANALYZE_CURRENT_PAGE" });
    if (!response?.ok) throw new Error(response?.error || "분석 응답이 없습니다.");
    const isChannelListing = response.analysis?.kind === "channel-listing";
    if (!isChannelListing && (!Array.isArray(response.analysis?.assets) || !response.analysis.assets.length)) {
      throw new Error("페이지에서 다운로드할 미디어를 찾지 못했습니다.");
    }
    renderAnalysis(response.analysis);

    if (isChannelListing) {
      // renderChannelListing()이 renderAnalysis() 안에서 자체적으로 로딩·완료 메시지를 표시한다.
    } else if (isNativeAnalysis() && nativeEngine() === "yt-dlp") {
      showMessage("Media Helper에서 영상 품질을 확인하고 있습니다…");
      await prepareNativeOptions(response.analysis, generation);
      if (generation === analysisGeneration) showMessage("영상 품질을 선택한 뒤 다운로드할 수 있습니다.");
    } else if (isNativeAnalysis() || (isImageAnalysis() && selectedImageFormat() === "webp")) {
      const helper = await chrome.runtime.sendMessage({ type: "PROBE_NATIVE_HELPER" });
      if (!helper?.ok) throw new Error(`Media Helper 연결 실패: ${helper?.error || "설치 상태를 확인하세요."}`);
      analysisDownloadReady = Boolean(analysis.complete);
      updateDownloadAction();
      const selected = selectedRangeAnalysis();
      showMessage(selectedImageFormat() === "webp"
        ? `${selected.assets.length}개 이미지를 WebP로 저장할 준비가 됐습니다.`
        : `${selected.assets.length}개 원본 이미지를 Helper로 안전하게 저장할 준비가 됐습니다.`);
    } else {
      analysisDownloadReady = Boolean(analysis.complete);
      updateDownloadAction();
      showMessage(`${analysis.mediaCount || analysis.assets.length}개 미디어를 순서대로 찾았습니다.`);
    }
  } catch (error) {
    if (generation !== analysisGeneration) return;
    analysis = null;
    analysisDownloadReady = false;
    elements.resultCard.classList.add("hidden");
    elements.channelCard.classList.add("hidden");
    setDownloadTarget(null);
    showMessage(error?.message || String(error), true);
  } finally {
    if (generation === analysisGeneration) elements.analyzeButton.disabled = false;
  }
}

async function startDownload() {
  if (!analysis) return;
  setDownloadActionBusy(true);
  const imageFormat = selectedImageFormat();
  const useHelper = isNativeAnalysis() || imageFormat === "webp";
  showMessage(useHelper ? "Media Helper에 미디어 작업을 전달하고 있습니다…" : "Chrome 다운로드 항목에 등록하고 있습니다…");
  try {
    const selected = selectedRangeAnalysis();
    if (!useHelper) await ensureDirectAssetPermissions(selected.assets);
    const requested = { ...selected, title: elements.titleInput.value.trim() || analysis.title };
    const response = await chrome.runtime.sendMessage({
      type: "START_DOWNLOAD",
      analysis: requested,
      root: elements.rootInput.value,
      options: {
        quality: elements.qualitySelect.value || "best",
        imageFormat,
      },
    });
    if (!response?.ok) throw new Error(response?.error || "작업을 시작하지 못했습니다.");
    applyStartedJob(
      response,
      "다운로드가 시작되었습니다. 패널을 닫아도 작업은 계속됩니다.",
      "현재 탭 작업을 대기열에 추가했습니다.",
    );
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    setDownloadActionBusy(false);
  }
}

elements.analyzeButton.addEventListener("click", analyzeCurrentTab);
elements.downloadButton.addEventListener("click", () => {
  if (downloadTarget === "playlist") return startPlaylistTranscripts();
  if (downloadTarget === "channel") return handleChannelDownload([...channelSelected.values()], channelName);
  return startDownload();
});
elements.playlistProbeButton.addEventListener("click", probePlaylist);
elements.playlistUrlInput.addEventListener("input", resetPlaylistPreview);
elements.longformMoreButton.addEventListener("click", loadChannelMore);
elements.shortsMoreButton.addEventListener("click", loadChannelMore);
elements.channelCard.addEventListener("change", (event) => {
  const itemCheckbox = event.target.closest(".channel-item-check");
  if (itemCheckbox) {
    const { kind, id } = itemCheckbox.dataset;
    const item = (kind === "longform" ? channelLongform : channelShorts).find((candidate) => candidate.id === id);
    if (!item) return;
    downloadTarget = "channel";
    const key = channelItemKey(kind, id);
    if (itemCheckbox.checked) channelSelected.set(key, { id: item.id, url: item.url, title: item.title, kind });
    else channelSelected.delete(key);
    renderChannelLists();
    return;
  }
  const selectAll = event.target.closest(".channel-select-all");
  if (selectAll) {
    downloadTarget = "channel";
    const { kind } = selectAll.dataset;
    const items = kind === "longform" ? channelLongform : channelShorts;
    for (const item of items) {
      const key = channelItemKey(kind, item.id);
      if (selectAll.checked) channelSelected.set(key, { id: item.id, url: item.url, title: item.title, kind });
      else channelSelected.delete(key);
    }
    renderChannelLists();
  }
});
// 항목 행 어디를 눌러도 체크박스 토글(체크박스 자체 클릭은 native가 처리하므로 제외).
elements.channelCard.addEventListener("click", (event) => {
  if (event.target.closest(".channel-item-check") || event.target.closest(".channel-group-header")) return;
  const checkbox = event.target.closest(".channel-item")?.querySelector(".channel-item-check");
  if (!checkbox) return;
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
});
elements.openFolderButton.addEventListener("click", openDownloadFolder);
elements.cancelJobButton.addEventListener("click", async () => {
  if (!currentJob?.id || TERMINAL_STATUSES.has(currentJob.status)) return;
  elements.cancelJobButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "CANCEL_DOWNLOAD_JOB", jobId: currentJob.id });
    if (!response?.ok) throw new Error(response?.error || "작업을 취소하지 못했습니다.");
    renderJob(response.job);
    upsertHistoryJob(response.job);
    showMessage("작업을 취소했습니다.");
  } catch (error) {
    elements.cancelJobButton.disabled = false;
    showMessage(error?.message || String(error), true);
  }
});
elements.refreshHistoryButton.addEventListener("click", loadHistory);
elements.clearHistoryButton.addEventListener("click", clearFinishedHistory);
elements.historyList.addEventListener("click", handleHistoryAction);
elements.queueList.addEventListener("click", handleQueueAction);
elements.queuePauseButton.addEventListener("click", async () => {
  elements.queuePauseButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SET_DOWNLOAD_QUEUE_PAUSED",
      paused: !queuePaused,
    });
    if (!response?.ok) throw new Error(response?.error || "대기열 상태를 바꾸지 못했습니다.");
    renderQueue(response.queue);
    showMessage(response.queue.paused ? "현재 작업이 끝난 뒤 대기열을 멈춥니다." : "대기열을 계속 진행합니다.");
  } catch (error) {
    showMessage(error?.message || String(error), true);
  } finally {
    elements.queuePauseButton.disabled = false;
  }
});
elements.historyToggleButton.addEventListener("click", () => {
  historyExpanded = !historyExpanded;
  renderHistory();
});
elements.titleInput.addEventListener("input", updatePathPreview);
elements.rootInput.addEventListener("input", updatePathPreview);
elements.imageFormatSelect.addEventListener("change", () => {
  updateImageFormatUi();
  chrome.storage.local.set({ imageFormat: elements.imageFormatSelect.value }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "DOWNLOAD_PROGRESS") {
    renderJob(message.job);
    upsertHistoryJob(message.job);
  }
  if (message?.type === "DOWNLOAD_QUEUE_UPDATED") renderQueue(message.queue);
});

chrome.runtime.sendMessage({ type: "GET_EXTENSION_STATE" })
  .then((state) => {
    if (state?.root) elements.rootInput.value = state.root;
    if (["original", "webp"].includes(state?.imageFormat)) elements.imageFormatSelect.value = state.imageFormat;
    updateImageFormatUi();
    if (state?.job) renderJob(state.job);
    if (state?.queue) renderQueue(state.queue);
  })
  .catch(() => {});

loadHistory();

refreshActiveTab().catch((error) => showMessage(error?.message || String(error), true));
chrome.tabs.onActivated.addListener(() => refreshActiveTab().catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTab?.id && (changeInfo.url || changeInfo.status === "complete")) {
    refreshActiveTab().catch(() => {});
  }
});

// 선택한 영상만 품질 조회와 다운로드에 사용한다.
elements.videoSelect.addEventListener("change", async () => {
  const selected = analysis?.videoCandidates?.[Number(elements.videoSelect.value)];
  if (!selected) return;
  analysis.assets = [selected];
  analysisDownloadReady = false;
  updateDownloadAction();
  const generation = ++analysisGeneration;
  try {
    await prepareNativeOptions(analysis, generation);
    if (generation === analysisGeneration) showMessage("영상 품질을 선택한 뒤 다운로드할 수 있습니다.");
  } catch (error) {
    if (generation === analysisGeneration) showMessage(error.message, true);
  }
});
