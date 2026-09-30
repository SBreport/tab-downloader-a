(() => {
  "use strict";

  if (globalThis.__TAB_IMAGE_ANALYZER_INSTALLED__) return;
  globalThis.__TAB_IMAGE_ANALYZER_INSTALLED__ = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "ANALYZE_CURRENT_PAGE") return undefined;

    Promise.resolve().then(async () => {
      const pageUrl = location.href;
      const adapter = globalThis.TabMediaAdapters?.find(pageUrl) ||
        globalThis.TabMediaAdapters?.registry.find((item) => item.type === "vimeo");
      if (!adapter) {
        throw new Error("이 탭의 주소와 일치하는 구현된 사이트 어댑터가 없습니다.");
      }
      const result = await adapter.extract(document, pageUrl);
      if (location.href !== pageUrl) {
        throw new Error("분석 중 페이지 주소가 변경되었습니다. 현재 작품에서 다시 분석해 주세요.");
      }
      return {
        ok: true,
        analysis: {
          schemaVersion: 1,
          type: adapter.type,
          siteName: adapter.displayName,
          backend: adapter.backend || "chrome",
          key: adapter.key(pageUrl),
          canonicalUrl: adapter.canonicalize(pageUrl),
          ...result,
        },
      };
    }).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  });
})();
