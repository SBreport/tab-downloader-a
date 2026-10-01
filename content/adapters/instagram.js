(() => {
  "use strict";
  const api = globalThis.TabMediaAdapters;
  const postPattern = /^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/;
  function parseUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
    const match = url.pathname.match(postPattern);
    return match ? { code: match[2], url: `${url.origin}/${match[1] === "reels" ? "reel" : match[1]}/${match[2]}/` } : null;
  }
  function mediaUrl(raw, kind) {
    try {
      const url = new URL(raw);
      const host = /(?:^|\.)cdninstagram\.com$/.test(url.hostname) || /^scontent[.-][a-z0-9.-]+\.fbcdn\.net$/.test(url.hostname);
      const ext = url.pathname.match(/\.(jpg|jpeg|png|webp|avif|mp4)$/i)?.[1]?.toLowerCase();
      if (url.protocol !== "https:" || !host || url.username || url.password || url.port || url.hash || !ext || (kind === "video" ? ext !== "mp4" : ext === "mp4")) return null;
      return { url: url.href, ext };
    } catch { return null; }
  }
  function extractData(document, post) {
    const matches = [];
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent || "";
      if (!text.includes(post.code) || text.length > 8 * 1024 * 1024) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }
      const stack = [parsed];
      let visited = 0;
      while (stack.length && visited++ < 200000) {
        const value = stack.pop();
        if (!value || typeof value !== "object") continue;
        if ((value.code === post.code || value.shortcode === post.code) && [1, 2, 8].includes(value.media_type)) matches.push(value);
        for (const child of Object.values(value)) if (child && typeof child === "object") stack.push(child);
      }
    }
    for (const node of matches) {
      const items = node.media_type === 8 ? node.carousel_media : [node];
      if (!Array.isArray(items) || !items.length || items.length > 100) continue;
      if (node.media_type === 8 && (!Number.isInteger(node.carousel_media_count) || items.length !== node.carousel_media_count)) continue;
      const assets = items.map((item, index) => {
        if (![1, 2].includes(item.media_type)) return null;
        const kind = item.media_type === 2 ? "video" : "image";
        const variants = kind === "video" ? item.video_versions : item.image_versions2?.candidates;
        const best = (Array.isArray(variants) ? variants : []).map((candidate) => ({
          media: mediaUrl(candidate.url, kind), area: (Number(candidate.width) || 0) * (Number(candidate.height) || 0),
        })).filter((candidate) => candidate.media).sort((a, b) => b.area - a.area)[0];
        if (!best) return null;
        const order = String(index + 1).padStart(4, "0");
        return { id: String(item.pk || item.id || order), kind, url: best.media.url, referer: "https://www.instagram.com/", filename: `${order}.${best.media.ext}`, delivery: { mode: "direct" } };
      });
      if (assets.some((item) => !item)) continue;
      const author = api.helpers.cleanText(node.user?.username) || "Instagram";
      return {
        title: `${author} - ${post.code}`,
        assets, mediaCount: assets.length, expectedCount: assets.length, complete: true,
        warnings: ["최대 해상도로 저장합니다. 링크 만료 시 다시 분석해 주세요.",
          ...(assets.some((a) => a.kind === "video") && assets.some((a) => a.kind === "image") ? ["사진·영상 혼합 게시물은 원본 형식으로 저장합니다."] : [])],
      };
    }
    return null;
  }
  api.register({
    type: "instagram", displayName: "Instagram", backend: "chrome",
    match(raw) { try { return new URL(raw).protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(new URL(raw).hostname); } catch { return false; } },
    canonicalize: (raw) => parseUrl(raw)?.url || raw,
    key: (raw) => parseUrl(raw)?.code || raw,
    async extract(document, raw) {
      const post = parseUrl(raw);
      if (!post) throw new Error("Instagram 프로필·목록에서는 게시물 또는 릴스를 연 뒤 분석해 주세요. 계정 전체 다운로드는 지원하지 않습니다.");
      const current = extractData(document, post);
      if (current) return current;
      // SPA로 연 게시물은 초기 JSON이 없을 수 있어 현재 게시물 HTML만 다시 읽는다.
      const response = await fetch(post.url, { credentials: "same-origin", signal: AbortSignal.timeout(20000) });
      if (!response.ok || new URL(response.url).origin !== new URL(post.url).origin || /\/accounts\//.test(new URL(response.url).pathname)) {
        throw new Error("Instagram 게시물을 읽지 못했습니다. 로그인 후 게시물을 직접 열고 다시 분석해 주세요.");
      }
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const result = extractData(page, post);
      if (!result) throw new Error("게시물의 전체 사진·영상 데이터를 확인하지 못했습니다. 게시물 탭을 새로고침한 뒤 다시 분석해 주세요. 일부 항목만 저장하지 않았습니다.");
      return result;
    },
  });
})();
