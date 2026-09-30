(() => {
  "use strict";

  if (globalThis.TabMediaAdapters) return;

  const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif",
  ]);
  const registry = [];

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function absoluteUrl(value, baseUrl) {
    if (!value || String(value).startsWith("data:")) return null;
    try {
      const url = new URL(value, baseUrl);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function extensionFrom(value, fallback = ".jpg") {
    try {
      const match = new URL(value).pathname.toLowerCase().match(/\.[a-z0-9]{2,5}$/);
      if (match && IMAGE_EXTENSIONS.has(match[0])) return match[0];
    } catch {
      // URL이 아니면 단순 확장자 검사를 사용한다.
    }
    const match = String(value ?? "").toLowerCase().match(/\.[a-z0-9]{2,5}$/);
    return match && IMAGE_EXTENSIONS.has(match[0]) ? match[0] : fallback;
  }

  function numberedImages(urls, referer, names = []) {
    const seen = new Set();
    const assets = [];
    for (let index = 0; index < urls.length; index += 1) {
      const url = absoluteUrl(urls[index], referer);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const ext = extensionFrom(names[index] || url);
      assets.push({
        id: String(assets.length + 1).padStart(4, "0"),
        kind: "image",
        url,
        referer,
        filename: `${String(assets.length + 1).padStart(4, "0")}${ext}`,
        delivery: { mode: "direct" },
      });
    }
    return assets;
  }

  function metaContent(document, property) {
    return cleanText(document.querySelector(`meta[property="${property}"]`)?.content);
  }

  function documentTitle(document, fallback) {
    return metaContent(document, "og:title") || cleanText(document.title) || fallback;
  }

  function candidateImageUrl(element, baseUrl) {
    for (const name of ["data-original", "data-src", "data-lazy-src", "src"]) {
      const url = absoluteUrl(element.getAttribute(name), baseUrl);
      if (url) return url;
    }
    return absoluteUrl(element.currentSrc, baseUrl);
  }

  function register(adapter) {
    if (!adapter?.type || typeof adapter.match !== "function") {
      throw new Error("잘못된 사이트 어댑터입니다.");
    }
    const index = registry.findIndex((item) => item.type === adapter.type);
    if (index >= 0) registry[index] = adapter;
    else registry.push(adapter);
  }

  globalThis.TabMediaAdapters = {
    registry,
    register,
    find(url) {
      return registry.find((adapter) => adapter.match(url)) || null;
    },
    helpers: {
      IMAGE_EXTENSIONS,
      absoluteUrl,
      candidateImageUrl,
      cleanText,
      documentTitle,
      extensionFrom,
      numberedImages,
    },
  };
})();
