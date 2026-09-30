// Toggle the main YouTube video using the browser's native PiP window.
(() => {
  "use strict";

  const BUTTON_ID = "tab-downloader-pip-button";
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = "ytp-button";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M19 11h-8v6h8v-6zm2-8H3a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z");
  svg.appendChild(path);
  button.appendChild(svg);

  let pending = false;
  let refreshTimer = null;

  function getVideo() {
    return document.querySelector("#movie_player video.html5-main-video");
  }

  function refresh() {
    const controls = location.pathname === "/watch"
      ? document.querySelector("#movie_player .ytp-right-controls") : null;
    if (!controls || !document.pictureInPictureEnabled) {
      button.remove();
      return;
    }
    const existing = document.getElementById(BUTTON_ID);
    if (existing && existing !== button) {
      button.remove();
      return;
    }
    if (button.parentElement !== controls) controls.prepend(button);

    const video = getVideo();
    const active = Boolean(video && document.pictureInPictureElement === video);
    const unavailable = !video || video.readyState === 0 || video.disablePictureInPicture;
    const label = active ? "작은 창(PiP) 닫기"
      : unavailable ? "영상을 재생한 뒤 작은 창(PiP)을 열 수 있습니다" : "작은 창(PiP)으로 보기";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = pending || (!active && unavailable);
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 100);
  }

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    const video = getVideo();
    if (!video) {
      refresh();
      return;
    }
    pending = true;
    button.disabled = true;
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (error) {
      console.warn("[Tab Downloader PiP]", error);
      const message = error.name === "NotAllowedError"
        ? "작은 창을 열지 못했습니다. 영상 재생 후 PiP 버튼을 다시 눌러 주세요."
        : error.name === "NotSupportedError" || error.name === "SecurityError"
          ? "현재 영상 또는 브라우저 설정에서 작은 창(PiP)을 사용할 수 없습니다."
          : "작은 창(PiP) 전환에 실패했습니다. 영상이 로드된 후 다시 시도해 주세요.";
      window.alert(message);
    } finally {
      pending = false;
      refresh();
    }
  });

  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-finish", scheduleRefresh);
  for (const event of ["enterpictureinpicture", "leavepictureinpicture", "loadedmetadata", "emptied"]) {
    document.addEventListener(event, scheduleRefresh, true);
  }
  refresh();
})();
