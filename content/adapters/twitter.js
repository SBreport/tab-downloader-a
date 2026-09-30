(() => {
  "use strict";
  const api = globalThis.TabMediaAdapters;
  if (!api) throw new Error("adapter-runtime이 먼저 필요합니다.");
  const { cleanText, numberedImages } = api.helpers;

  function parsePostUrl(rawUrl) {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!(host === "x.com" || host === "twitter.com") || !match) return null;
    return { handle: match[1], statusId: match[2] };
  }

  function findTargetArticle(document, statusId) {
    const links = [...document.querySelectorAll(`a[href*="/status/${statusId}"]`)];
    return links.map((link) => link.closest?.("article")).find(Boolean) || null;
  }

  function displayNameFrom(article, fallback) {
    const raw = article.querySelector?.('[data-testid="User-Name"]')?.innerText || "";
    const line = raw.split(/\r?\n/).map((value) => cleanText(value)).find((value) => value && !value.startsWith("@"));
    return line || fallback;
  }

  function originalPhotoUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) return null;
      const pathExtension = url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1];
      const format = (url.searchParams.get("format") || pathExtension || "jpg").toLowerCase();
      url.search = "";
      url.searchParams.set("format", format);
      url.searchParams.set("name", "orig");
      return { url: url.href, filename: `photo.${format}` };
    } catch {
      return null;
    }
  }

  api.register({
    type: "twitter",
    displayName: "X / Twitter Post",
    backend: "native",
    match(url) {
      try { return Boolean(parsePostUrl(url)); } catch { return false; }
    },
    canonicalize(url) {
      const parsed = parsePostUrl(url);
      return parsed ? `https://x.com/${encodeURIComponent(parsed.handle)}/status/${parsed.statusId}` : url;
    },
    key(url) {
      return parsePostUrl(url)?.statusId || url;
    },
    extract(document, url) {
      const parsed = parsePostUrl(url);
      if (!parsed) throw new Error("X 개별 게시물 주소가 아닙니다.");
      const canonicalUrl = this.canonicalize(url);
      const article = findTargetArticle(document, parsed.statusId);
      if (!article) throw new Error("현재 status ID에 해당하는 원문 게시물을 찾지 못했습니다. 페이지 로딩 후 다시 분석해 주세요.");

      const displayName = displayNameFrom(article, parsed.handle);
      const title = `${displayName} (@${parsed.handle}) - ${parsed.statusId}`;
      const photoCandidates = [...article.querySelectorAll('a[href*="/photo/"] img')]
        .map((image) => originalPhotoUrl(image.currentSrc || image.src || image.getAttribute?.("src")))
        .filter(Boolean);
      const photos = numberedImages(
        photoCandidates.map((item) => item.url),
        canonicalUrl,
        photoCandidates.map((item) => item.filename),
      );
      const videoCount = Math.max(
        article.querySelectorAll("video").length,
        article.querySelectorAll('[data-testid="videoPlayer"]').length,
      );

      if (videoCount && photos.length) {
        throw new Error("사진과 영상이 함께 있는 X 게시물은 아직 지원하지 않습니다.");
      }
      if (videoCount) {
        return {
          backend: "native",
          title,
          mediaCount: videoCount,
          assets: [{
            id: parsed.statusId,
            kind: "video",
            filename: "0001.mp4",
            itemCount: videoCount,
            delivery: { mode: "native", engine: "yt-dlp", pageUrl: canonicalUrl },
          }],
          expectedCount: videoCount,
          complete: true,
          warnings: [],
        };
      }
      if (photos.length) {
        return {
          backend: "chrome",
          title,
          mediaCount: photos.length,
          assets: photos,
          expectedCount: photos.length,
          complete: true,
          warnings: [],
        };
      }
      throw new Error("원문 게시물에서 사진 또는 영상을 찾지 못했습니다.");
    },
  });
})();
