(() => {
  "use strict";
  const api = globalThis.TabMediaAdapters;
  function vimeoUrl(raw, base) {
    try {
      const url = new URL(raw, base);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      const player = url.hostname === "player.vimeo.com" && /^\/video\/\d+\/?$/.test(url.pathname);
      const page = ["vimeo.com", "www.vimeo.com"].includes(url.hostname) && /^\/\d+(?:\/[a-zA-Z0-9]+)?\/?$/.test(url.pathname);
      if (!player && !page) return null;
      const result = new URL(url.origin + url.pathname);
      if (url.searchParams.has("h")) result.searchParams.set("h", url.searchParams.get("h"));
      return result.href;
    } catch { return null; }
  }
  api.register({
    type: "vimeo",
    displayName: "페이지 내 영상 · Vimeo",
    backend: "native",
    match: (url) => Boolean(vimeoUrl(url)),
    canonicalize: (url) => url,
    key: (url) => url,
    extract(document, pageUrl) {
      const urls = new Set();
      const direct = vimeoUrl(pageUrl);
      if (direct) urls.add(direct);
      for (const frame of document.querySelectorAll("iframe")) {
        for (const attr of ["src", "data-src"]) {
          const raw = frame.getAttribute(attr);
          const url = raw && vimeoUrl(raw, pageUrl);
          if (url) urls.add(url);
        }
      }
      if (!urls.size) throw new Error("페이지에서 지원하는 영상을 찾지 못했습니다. 현재 Vimeo 직접 영상과 페이지 내 Vimeo iframe을 지원합니다. 영상을 표시한 뒤 다시 분석해 주세요.");
      const title = api.helpers.cleanText(document.querySelector("h1")?.textContent) || api.helpers.documentTitle(document, "Vimeo video");
      // ponytail: 중첩된 다른 출처 iframe 탐색은 실제 지원 사례가 생기면 추가한다.
      const candidates = [...urls].map((url) => ({
        id: new URL(url).pathname.match(/\d+/)[0],
        kind: "video",
        filename: `${title}.mp4`,
        delivery: { mode: "native", engine: "yt-dlp", pageUrl: url, referer: pageUrl },
      }));
      return { title, assets: [candidates[0]], videoCandidates: candidates, expectedCount: 1, complete: true, warnings: [] };
    },
  });
})();
