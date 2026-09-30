(() => {
  "use strict";
  const api = globalThis.TabMediaAdapters;
  if (!api) throw new Error("adapter-runtime이 먼저 필요합니다.");
  const { cleanText, documentTitle } = api.helpers;

  const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

  // 채널 페이지(예: /@handle, /@handle/videos, /channel/UC.., /c/.., /user/..) 판별.
  function channelPathname(value) {
    if (!YOUTUBE_HOSTS.has(value.hostname)) return null;
    const segments = value.pathname.split("/").filter(Boolean);
    const [head] = segments;
    if (!head) return null;
    const isTrailer = (segment) => segment === undefined || segment === "videos" || segment === "shorts";
    if (head.startsWith("@") && segments.length <= 2 && isTrailer(segments[1])) return `/${head}`;
    if ((head === "channel" || head === "c" || head === "user") && segments[1] && segments.length <= 3 && isTrailer(segments[2])) {
      return `/${head}/${segments[1]}`;
    }
    return null;
  }

  api.register({
    type: "youtube",
    displayName: "YouTube",
    backend: "native",
    match(url) {
      try {
        const value = new URL(url);
        return (
          ((value.hostname === "www.youtube.com" || value.hostname === "youtube.com" || value.hostname === "m.youtube.com") &&
            (value.pathname === "/watch" || value.pathname.startsWith("/shorts/") || value.pathname.startsWith("/live/"))) ||
          value.hostname === "youtu.be" ||
          channelPathname(value) !== null
        );
      } catch { return false; }
    },
    canonicalize(url) {
      const value = new URL(url);
      const channelBase = channelPathname(value);
      if (channelBase) return `https://www.youtube.com${channelBase}`;
      let id = "";
      if (value.hostname === "youtu.be") id = value.pathname.split("/").filter(Boolean)[0] || "";
      else if (value.pathname === "/watch") id = value.searchParams.get("v") || "";
      else id = value.pathname.split("/").filter(Boolean)[1] || "";
      return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : url;
    },
    key(url) {
      const value = new URL(url);
      if (channelPathname(value)) return this.canonicalize(url);
      return new URL(this.canonicalize(url)).searchParams.get("v") || url;
    },
    extract(document, url) {
      if (channelPathname(new URL(url))) {
        return {
          backend: "native",
          type: "youtube",
          kind: "channel-listing",
          channel: {
            url: this.canonicalize(url),
            name: cleanText(document.querySelector('meta[property="og:title"]')?.content) ||
              documentTitle(document, "YouTube channel").replace(/\s*-\s*YouTube\s*$/i, ""),
          },
          assets: [],
          expectedCount: 0,
          complete: false,
          warnings: [],
        };
      }
      const canonicalUrl = this.canonicalize(url);
      const title = cleanText(document.querySelector("h1 yt-formatted-string")?.textContent) ||
        cleanText(document.querySelector('meta[name="title"]')?.content) ||
        documentTitle(document, "YouTube video").replace(/\s*-\s*YouTube\s*$/i, "");
      return {
        title,
        assets: [{
          id: this.key(url),
          kind: "video",
          filename: `${title || "video"}.mp4`,
          delivery: { mode: "native", engine: "yt-dlp", pageUrl: canonicalUrl },
        }],
        expectedCount: 1,
        complete: true,
        warnings: [],
      };
    },
  });
})();
