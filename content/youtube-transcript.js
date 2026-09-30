// YouTube Script Copy & Download - Content Script (ISOLATED world)
// Primary: InnerTube API (like Glasp), Fallback: transcript panel DOM scraping
(() => {
  'use strict';

  const BUTTON_ID = 'yt-script-copy-btn';
  const CONTAINER_SEL = 'ytd-watch-metadata #top-level-buttons-computed';
  const PARA_MIN_CHARS = 300;   // 이 글자수 이상 + 문장종결 → 문단 분리
  const PARA_MAX_CHARS = 800;   // 이 글자수 초과 시 강제 분리
  const PARA_TIME_GAP  = 10.0;  // 10초 이상 침묵 → 주제 전환으로 간주, 강제 분리
  const LOG = (...args) => console.log('[YT Script Copy]', ...args);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let documentCache = null;

  // ─── Utilities ───────────────────────────────────────────────

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); reject(new Error(`timeout: ${selector}`)); }, timeout);
    });
  }

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatTimestamp(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function parseTimestamp(str) {
    const parts = str.trim().split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function decodeHTMLEntities(text) {
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, ' ').trim();
  }

  async function copyToClipboard(text) {
    window.focus();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  function downloadText(text, title) {
    const safeTitle = title
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'youtube-script';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeTitle}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // ─── Metadata (from DOM) ────────────────────────────────────

  function extractMetadata() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    const title =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
      document.title.replace(' - YouTube', '').trim() || '제목 없음';
    const channel =
      document.querySelector('#channel-name yt-formatted-string a')?.textContent?.trim() ||
      document.querySelector('#channel-name yt-formatted-string')?.textContent?.trim() || '채널명 없음';
    const durationEl = document.querySelector('.ytp-time-duration');
    const lengthSeconds = durationEl ? parseTimestamp(durationEl.textContent) : 0;
    const dateEl = document.querySelector('#info-strings yt-formatted-string');

    return {
      title, channel, lengthSeconds, videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      uploadDate: dateEl?.textContent?.trim() || '',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // METHOD 1: InnerTube API (same approach as Glasp extension)
  // ═══════════════════════════════════════════════════════════════

  function extractTranscriptParams(html) {
    const parts = html.split('"getTranscriptEndpoint":');
    if (parts.length < 2) return '';
    try { return parts[1].split('"params":"')[1].split('"')[0] || ''; }
    catch { return ''; }
  }

  async function method1_API(videoId) {
    LOG('Method 1: InnerTube API 시도...');

    // Step 1: 현재 페이지 DOM에서 params 추출 시도 (네트워크 요청 없이 즉시)
    let params = '';
    try {
      const domHtml = document.documentElement.innerHTML;
      params = extractTranscriptParams(domHtml);
      if (params) LOG('  ✓ DOM에서 params 추출 (빠른 경로)');
    } catch (e) {
      LOG('  DOM 추출 실패:', e.message);
    }

    // Fallback: DOM에 없으면 페이지 HTML 재다운로드
    if (!params) {
      LOG('  DOM에 params 없음, 페이지 재다운로드...');
      const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        credentials: 'omit',
        headers: { 'DNT': '1', 'Upgrade-Insecure-Requests': '1', 'Cache-Control': 'no-cache', Cookie: '' },
        mode: 'cors',
        cache: 'no-store',
      });
      const pageHtml = await pageResp.text();
      LOG('  페이지 HTML 길이:', pageHtml.length);
      params = extractTranscriptParams(pageHtml);
    }

    if (!params) throw new Error('자막 파라미터 없음');
    LOG('  params 추출 완료, 길이:', params.length);

    // Step 2: Call get_transcript (default credentials = same-origin = includes cookies)
    const dates = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - i);
      return d.toISOString().split('T')[0].replace(/-/g, '');
    });
    const version = `2.${dates[Math.floor(Math.random() * dates.length)]}.00.00`;

    const resp = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: version } },
        params,
      }),
    });
    LOG('  API 응답 status:', resp.status);

    const text = await resp.text();
    if (!text) throw new Error('빈 응답');

    const data = JSON.parse(text);
    if (data.error) throw new Error(`API ${data.error.code}: ${data.error.message}`);

    const panel = data?.actions?.[0]?.updateEngagementPanelAction?.content
      ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer;
    if (!panel) throw new Error('응답에 트랜스크립트 없음');

    const segments = (panel?.body?.transcriptSegmentListRenderer?.initialSegments || [])
      .map(seg => {
        const r = seg?.transcriptSegmentRenderer;
        if (!r?.startMs || !r?.snippet?.runs?.[0]?.text) return null;
        return {
          start: Number(r.startMs) / 1000,
          text: decodeHTMLEntities(r.snippet.runs[0].text),
        };
      })
      .filter(Boolean);

    if (segments.length === 0) throw new Error('세그먼트 0개');
    LOG('  성공! 세그먼트:', segments.length);
    return segments;
  }

  // ═══════════════════════════════════════════════════════════════
  // METHOD 1.5: timedtext caption URL + poToken (가장 견고)
  // get_transcript가 400(Precondition)으로 죽는 영상(일부공개 등)에서도 동작
  // ═══════════════════════════════════════════════════════════════

  // 페이지 HTML 텍스트에서 captionTracks 배열을 문자열 인식 괄호매칭으로 추출
  function extractCaptionTracks(html) {
    const key = '"captionTracks":';
    const i = html.indexOf(key);
    if (i < 0) return [];
    const start = html.indexOf('[', i + key.length);
    if (start < 0) return [];
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < html.length; j++) {
      const ch = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch { return []; }
      } }
    }
    return [];
  }

  function pickCaptionTrack(tracks) {
    if (!tracks.length) return null;
    return tracks.find(t => t.kind !== 'asr') || tracks[0]; // 수동 자막 우선, 없으면 자동생성
  }

  // 자막(CC) 버튼을 토글해 YouTube가 /api/timedtext?...&pot= 요청을 쏘게 만들고
  // Performance Resource Timing에서 poToken을 가로챈다 (영상 재생 불필요)
  const _potCache = {};
  async function getCaptionPoToken(videoId) {
    if (_potCache[videoId]) return _potCache[videoId];
    const btn = document.querySelector('.ytp-subtitles-button.ytp-button') ||
      document.querySelector('button.ytp-subtitles-button');
    if (!btn) { LOG('  CC 버튼 없음'); return ''; }
    try {
      performance.clearResourceTimings();
      btn.click();            // 자막 토글 → timedtext 요청 발생
      await sleep(250);
      btn.click();            // 원상복구 (2회 클릭 = 시작 상태로)
      for (let t = 0; t < 3000; t += 100) {
        await sleep(100);
        const e = performance.getEntriesByType('resource')
          .filter(r => r.name.includes('/api/timedtext?')).pop();
        if (e) {
          const pot = new URL(e.name).searchParams.get('pot');
          if (pot) { _potCache[videoId] = pot; LOG('  poToken 획득, 길이:', pot.length); return pot; }
        }
      }
    } catch (e) { LOG('  poToken 추출 오류:', e.message); }
    return '';
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    return (data.events || [])
      .filter(ev => ev.segs)
      .map(ev => ({
        start: (ev.tStartMs || 0) / 1000,
        text: ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim(),
      }))
      .filter(s => s.text);
  }

  async function method1_5_TimedText(videoId) {
    LOG('Method 1.5: timedtext + poToken 시도...');
    const tracks = extractCaptionTracks(document.documentElement.innerHTML);
    if (!tracks.length) throw new Error('captionTracks 없음');
    const track = pickCaptionTrack(tracks);
    LOG('  자막 트랙:', track.languageCode, track.kind || 'manual');

    const pot = await getCaptionPoToken(videoId);

    let url = track.baseUrl.replace(/([?&])fmt=[^&]*/g, '$1').replace(/[?&]$/, '');
    url += (url.includes('?') ? '&' : '?') + 'fmt=json3';
    if (pot) url += `&pot=${pot}&c=WEB`;

    const resp = await fetch(url); // same-origin → 쿠키 포함 (일부공개/제한 영상 대응)
    LOG('  timedtext status:', resp.status);
    const text = await resp.text();
    if (!text) throw new Error('빈 자막 응답 (poToken 누락 가능)');

    const segments = parseJson3(text);
    if (segments.length === 0) throw new Error('세그먼트 0개');
    LOG('  성공! 세그먼트:', segments.length);
    return segments;
  }

  // ═══════════════════════════════════════════════════════════════
  // METHOD 2: Transcript Panel DOM Scraping (fallback)
  // ═══════════════════════════════════════════════════════════════

  async function method2_PanelScrape() {
    LOG('Method 2: 패널 스크래핑 시도...');

    // Open transcript panel
    const expandBtn = document.querySelector('tp-yt-paper-button#expand');
    if (expandBtn) { expandBtn.click(); await new Promise(r => setTimeout(r, 500)); }

    const btnSelectors = [
      'ytd-video-description-transcript-section-renderer button',
      'button[aria-label*="스크립트"]',
      'button[aria-label*="transcript" i]',
    ];
    let clicked = false;
    for (const sel of btnSelectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); clicked = true; LOG('  버튼 클릭:', sel); break; }
    }
    if (!clicked) throw new Error('스크립트 버튼 없음');

    // Wait for segments to appear (poll instead of checking panel visibility)
    LOG('  세그먼트 대기 중...');
    let segments = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      segments = scrapeAllSegments();
      if (segments.length > 0) break;
    }

    if (segments.length === 0) throw new Error('세그먼트를 찾을 수 없음');

    // Scroll to load all segments
    const panel = findAnyTranscriptPanel();
    if (panel) {
      const scrollable = panel.querySelector('#content');
      if (scrollable) {
        let prevCount = 0, stable = 0;
        for (let i = 0; i < 60; i++) {
          scrollable.scrollTop = scrollable.scrollHeight;
          await new Promise(r => setTimeout(r, 250));
          const count = scrapeAllSegments().length;
          if (count === prevCount) { stable++; if (stable >= 3) break; }
          else stable = 0;
          prevCount = count;
        }
        scrollable.scrollTop = 0;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    segments = scrapeAllSegments();
    LOG('  성공! 세그먼트:', segments.length);

    // Close panel
    if (panel) {
      const closeBtn = panel.querySelector('#visibility-button button') ||
        panel.querySelector('button[aria-label="닫기"]') ||
        panel.querySelector('button[aria-label="Close"]');
      if (closeBtn) closeBtn.click();
    }

    return segments;
  }

  function findAnyTranscriptPanel() {
    const panels = document.querySelectorAll('ytd-engagement-panel-section-list-renderer');
    for (const p of panels) {
      const tid = p.getAttribute('target-id') || '';
      if (tid.includes('transcript') || tid.includes('Transcript') || tid === 'PAmodern_transcript_view') {
        return p;
      }
    }
    return null;
  }

  function scrapeAllSegments() {
    // Modern: transcript-segment-view-model (anywhere in document)
    const modernSegs = document.querySelectorAll('transcript-segment-view-model');
    if (modernSegs.length > 0) {
      const segments = [];
      for (const seg of modernSegs) {
        const divs = seg.querySelectorAll('div');
        const span = seg.querySelector('span');
        const ts = divs[0]?.textContent?.trim() || '';
        const text = span?.textContent?.trim() || '';
        if (ts && text) segments.push({ start: parseTimestamp(ts), text });
      }
      return segments;
    }

    // Legacy: ytd-transcript-segment-renderer
    const legacySegs = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (legacySegs.length > 0) {
      const segments = [];
      for (const seg of legacySegs) {
        const ts = seg.querySelector('.segment-timestamp')?.textContent?.trim() || '';
        const text = seg.querySelector('.segment-text')?.textContent?.trim() || '';
        if (ts && text) segments.push({ start: parseTimestamp(ts), text });
      }
      return segments;
    }

    return [];
  }

  // ─── Paragraph Grouping ─────────────────────────────────────

  function groupIntoParagraphs(segments) {
    if (!segments.length) return [];
    const paragraphs = [];
    let current = { startTime: segments[0].start, texts: [] };

    for (let i = 0; i < segments.length; i++) {
      current.texts.push(segments[i].text);
      const accumulated = current.texts.join(' ');
      const charLen = accumulated.length;

      if (i < segments.length - 1) {
        const gap = segments[i + 1].start - segments[i].start;
        const trimmed = segments[i].text.trim();
        // 한국어 종결어미(다, 요, 죠, 니다 등) 또는 일반 구두점
        const endsSentence = /[.!?。！？]$/.test(trimmed) ||
          /(?:다|요|죠|니다|까요|세요|네요|습니다|됩니다|합니다|입니다|었다|였다|겠다|한다|인다|된다|나요|던가|는데|거든|잖아|구나|더라|니까|래요|네|거야|는걸|지요)$/.test(trimmed);

        const shouldBreak =
          gap >= PARA_TIME_GAP ||                              // 긴 침묵 → 강제
          charLen >= PARA_MAX_CHARS ||                         // 최대 글자수 초과 → 강제
          (charLen >= PARA_MIN_CHARS && endsSentence);         // 최소 글자수 이상 + 문장 종결

        if (shouldBreak) {
          paragraphs.push({ timestamp: formatTimestamp(current.startTime), text: accumulated });
          current = { startTime: segments[i + 1].start, texts: [] };
        }
      }
    }
    if (current.texts.length) {
      paragraphs.push({ timestamp: formatTimestamp(current.startTime), text: current.texts.join(' ') });
    }
    return paragraphs;
  }

  // ─── Button Injection ───────────────────────────────────────

  function createIconButton(label, pathData, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.dataset.label = label;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    button.appendChild(svg);
    button.addEventListener('click', () => handleAction(button, handler));
    return button;
  }

  function tryInjectButton() {
    if (location.pathname !== '/watch') return;
    if (document.getElementById(BUTTON_ID)) return;
    // 재생목록/댓글 메뉴에도 같은 id의 컨테이너가 여러 개 존재 → 메인 액션바로 스코프
    const container = document.querySelector(CONTAINER_SEL);
    if (!container) return;

    const wrapper = document.createElement('div');
    wrapper.id = BUTTON_ID;
    wrapper.appendChild(createIconButton(
      '스크립트 복사',
      'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
      ({ text }) => copyToClipboard(text),
    ));
    wrapper.appendChild(createIconButton(
      '스크립트 다운로드',
      'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
      ({ text, meta }) => downloadText(text, meta.title),
    ));
    container.prepend(wrapper);
  }

  // ─── Copy / Download Handler ────────────────────────────────

  async function buildScriptDocument() {
    const meta = extractMetadata();

    // Method 1(API) → 1.5(timedtext+poToken) → 2(패널) 순서로 폴백
    let segments = null;
    const errs = [];

    for (const [label, fn] of [
      ['API', () => method1_API(meta.videoId)],
      ['timedtext', () => method1_5_TimedText(meta.videoId)],
      ['패널', () => method2_PanelScrape()],
    ]) {
      try {
        segments = await fn();
        if (segments && segments.length) break;
      } catch (e) {
        errs.push(`${label}: ${e.message}`);
        LOG(`Method(${label}) 실패:`, e.message);
      }
    }

    if (!segments || !segments.length) throw new Error(errs.join(' / '));

    const paragraphs = groupIntoParagraphs(segments);
    const transcriptSection = paragraphs.map(p => `[${p.timestamp}]\n${p.text}`).join('\n\n');

    const lines = [`제목: ${meta.title}`, `채널: ${meta.channel}`, `길이: ${formatDuration(meta.lengthSeconds)}`];
    if (meta.uploadDate) lines.push(`업로드: ${meta.uploadDate}`);
    lines.push(`URL: ${meta.url}`, '', '--- 스크립트 ---', '', transcriptSection);
    return { meta, text: lines.join('\n') };
  }

  async function getScriptDocument() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    if (documentCache?.meta.videoId === videoId) return documentCache;
    documentCache = await buildScriptDocument();
    return documentCache;
  }

  async function handleAction(button, action) {
    const buttons = document.querySelectorAll(`#${BUTTON_ID} button`);
    buttons.forEach(item => { item.disabled = true; });
    button.className = 'loading';
    button.setAttribute('aria-label', '스크립트 추출 중');

    try {
      await action(await getScriptDocument());
      button.className = 'success';
      button.setAttribute('aria-label', `${button.dataset.label} 완료`);
    } catch (error) {
      LOG('최종 오류:', error);
      button.className = 'error';
      button.setAttribute('aria-label', `${button.dataset.label} 실패`);
    }

    setTimeout(() => {
      button.className = '';
      button.setAttribute('aria-label', button.dataset.label);
      buttons.forEach(item => { item.disabled = false; });
    }, 1500);
  }

  // ─── SPA Navigation ─────────────────────────────────────────

  function onNavigate() {
    if (location.pathname !== '/watch') return;
    waitForElement(CONTAINER_SEL).then(() => tryInjectButton()).catch(() => {});
  }

  // YouTube 폴리머가 액션바를 다시 그리면 버튼이 지워지므로, DOM 변화 시 재주입
  const reinjectObserver = new MutationObserver(() => {
    if (location.pathname === '/watch' && !document.getElementById(BUTTON_ID)) tryInjectButton();
  });
  reinjectObserver.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('yt-navigate-finish', onNavigate);
  LOG('content script 로드됨:', location.href);
  onNavigate();
})();
