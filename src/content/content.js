/* Siphon content script: page detection + premium overlay (Shadow DOM). */
(() => {
  'use strict';
  if (window.__siphonInjected) return;
  window.__siphonInjected = true;

  const MSG = {
    DETECT_VIDEO: 'DETECT_VIDEO',
    GET_STREAMS: 'GET_STREAMS',
    STREAMS_UPDATED: 'STREAMS_UPDATED',
    DOWNLOAD_STREAM: 'DOWNLOAD_STREAM',
    DOWNLOAD_ALL_EPISODES: 'DOWNLOAD_ALL_EPISODES',
    DOWNLOAD_ALL_STATUS: 'DOWNLOAD_ALL_STATUS',
  };

  const ctxOk = () => { try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch { return false; } };
  const send = (m) => { if (!ctxOk()) return Promise.reject(new Error('context')); try { return chrome.runtime.sendMessage(m); } catch (e) { return Promise.reject(e); } };
  const safeNum = (n) => (Number.isFinite(n) ? n : 0);

  // ---------- page detection (video elements + series episodes API) ----------
  function collectVideos() {
    const found = [];
    const walk = (root) => {
      try { root.querySelectorAll('video').forEach((v) => found.push(v)); } catch {}
      try { root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); }); } catch {}
      try { root.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument) walk(f.contentDocument); } catch {} }); } catch {}
    };
    walk(document);
    return found.map((v, i) => {
      let src = v.currentSrc || v.src || '';
      if (!src) { const s = v.querySelector('source'); if (s) src = s.src; }
      const r = v.getBoundingClientRect();
      return { index: i, src, currentTime: safeNum(v.currentTime), duration: safeNum(v.duration), paused: v.paused, visible: r.width > 0 && r.height > 0 };
    });
  }
  function pickActive(videos) {
    const pool = videos.filter((v) => !v.paused && v.visible);
    const list = pool.length ? pool : (videos.filter((v) => v.visible).length ? videos.filter((v) => v.visible) : videos);
    if (!list.length) return null;
    return list.reduce((a, b) => (b.duration > a.duration ? b : a));
  }
  function scanPageMeta() {
    try {
      const html = (document.documentElement && document.documentElement.outerHTML) || '';
      const urls = Array.from(new Set((html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g) || [])));
      let dramaId = null;
      let m = html.match(/\/api\/drama\/(\d+)\/episodes/); if (m) dramaId = m[1];
      if (!dramaId) { m = html.match(/"dramaID"\s*:\s*"(\d+)"/); if (m) dramaId = m[1]; }
      let apis = [];
      try {
        for (const e of (performance.getEntriesByType ? performance.getEntriesByType('resource') : [])) {
          const name = e.name || '';
          if (name.includes('/api/drama/') && /\/episodes(?:[?#]|$)/.test(name) && !name.includes('danmaku')) {
            if (!apis.includes(name)) apis.push(name);
            const mm = name.match(/\/api\/drama\/(\d+)\/episodes/); if (mm) dramaId = mm[1];
          }
        }
      } catch {}
      if (!apis.length && dramaId) {
        const apiHost = /dramawave/i.test(location.hostname) ? 'dramawave.chartdrama.com' : 'reelshort.chartdrama.com';
        apis.push(`https://${apiHost}/api/drama/${dramaId}/episodes`);
      }
      return { mediaUrls: urls, dramaId, episodesApiUrls: apis, episodesApiUrl: apis[0] || null };
    } catch { return { mediaUrls: [], dramaId: null, episodesApiUrls: [], episodesApiUrl: null }; }
  }

  // --- chartdrama.com native support (reverse-engineered) -------------------
  // Pages: /d/{bookId}/{slug} (detail) and /p/{bookId}/{slug}?ep=N (player)
  //   GET /api/watch/{bookId}%2F{slug} -> { dramaId, title, embedUrl, ... }
  //   GET /api/drama/{dramaId}/episodes -> { items: [{ ep, url }] }  (url = direct HLS)
  // The video CDN host varies per drama (rivoshort / versevoyagetv / viscame / ...),
  // so we always trust the url returned by the API. No auth, no tokens, one call = all eps.
  const CHARTDRAMA_RE = /(^|\.)chartdrama\.com$/i;
  let _chart = { path: null, series: null };
  function parseDramaPath() {
    // Landing is /d/{bookId}/{slug}; the player navigates to /p/{bookId}/{slug}?ep=N.
    // Both resolve through the same /api/watch/{bookId}/{slug} endpoint.
    const m = location.pathname.match(/^\/[dp]\/([^/]+)\/(.+?)\/?$/);
    return m ? { bookId: m[1], slug: m[2] } : null;
  }
  async function chartdramaSeries() {
    if (!CHARTDRAMA_RE.test(location.hostname)) return null;
    const p = parseDramaPath();
    if (!p) return null;
    if (_chart.path === location.pathname && _chart.series) return _chart.series;
    try {
      const watchUrl = `${location.origin}/api/watch/${encodeURIComponent(p.bookId + '/' + p.slug)}`;
      const watch = await fetch(watchUrl, { credentials: 'include' }).then((r) => (r.ok ? r.json() : null));
      if (!watch || !watch.dramaId) return null;
      const episodesApiUrl = `${location.origin}/api/drama/${watch.dramaId}/episodes`;
      const series = {
        site: 'chartdrama',
        dramaId: String(watch.dramaId),
        title: (watch.title || document.title || 'drama').trim(),
        embedUrl: watch.embedUrl || null,
        episodesApiUrls: [episodesApiUrl],
        episodesApiUrl,
      };
      _chart = { path: location.pathname, series };
      return series;
    } catch { return null; }
  }

  // --- instagram.com native support --------------------------------------
  // Reels/posts play via blob: MSE, so the passive detector never sees a file.
  // But Instagram embeds the media in <script type="application/json"> blobs,
  // including video_versions[].url -> a direct, signed, progressive .mp4 on
  // fbcdn (no cipher, no login for public posts). We scrape the best one and
  // inject it as a downloadable card. Carousels expose several videos.
  const INSTAGRAM_RE = /(^|\.)instagram\.com$/i;
  let _ig = { path: null, vids: [] };
  function parseInstaPath() {
    const m = location.pathname.match(/^\/(?:reel|reels|p|tv)\/([^/]+)/);
    return m ? { shortcode: m[1] } : null;
  }
  function instagramVideos() {
    if (!INSTAGRAM_RE.test(location.hostname)) return [];
    const p = parseInstaPath();
    if (!p) return [];
    if (_ig.path === location.pathname && _ig.vids.length) return _ig.vids;
    const urls = [];
    const seen = new Set();
    const deref = (obj, fn, depth = 0) => {
      if (!obj || depth > 14) return;
      try { fn(obj); if (typeof obj === 'object') for (const k in obj) deref(obj[k], fn, depth + 1); } catch {}
    };
    try {
      for (const sc of document.querySelectorAll('script[type="application/json"]')) {
        let data; try { data = JSON.parse(sc.textContent); } catch { continue; }
        deref(data, (node) => {
          if (node && Array.isArray(node.video_versions) && node.video_versions.length) {
            const best = node.video_versions.slice().sort(
              (a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0))
            )[0] || node.video_versions[0];
            if (best && best.url && !seen.has(best.url)) { seen.add(best.url); urls.push(best.url); }
          }
        });
      }
    } catch {}
    const owner = ((document.title.match(/^(.*?)\s+on Instagram/) || [])[1] || 'instagram').trim();
    const vids = urls.map((url, i) => ({
      id: 'ig:' + p.shortcode + ':' + i,
      url, kind: 'file',
      name: urls.length > 1 ? `${p.shortcode} (${i + 1})` : p.shortcode,
      host: (() => { try { return new URL(url).host; } catch { return 'instagram'; } })(),
      dlTitle: urls.length > 1 ? `${owner}_${p.shortcode}_${i + 1}` : `${owner}_${p.shortcode}`,
      instagram: true,
    }));
    _ig = { path: location.pathname, vids };
    return vids;
  }

  if (ctxOk()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === MSG.DETECT_VIDEO) {
        (async () => {
          try {
            const videos = collectVideos();
            let meta = scanPageMeta();
            const cs = await chartdramaSeries();
            if (cs) meta = { ...meta, dramaId: cs.dramaId, title: cs.title, embedUrl: cs.embedUrl, episodesApiUrls: cs.episodesApiUrls, episodesApiUrl: cs.episodesApiUrl };
            sendResponse({ ok: true, video: pickActive(videos), count: videos.length, ...meta });
          } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
        })();
        return true;
      }
      if (msg && msg.type === MSG.STREAMS_UPDATED) { ui.setStreams(msg.streams || []); return; }
      if (msg && msg.type === MSG.DOWNLOAD_ALL_STATUS) { ui.onStatus(msg.payload || {}); return; }
    });
  }

  // ---------- overlay ----------
  const KIND = {
    hls:  { label: 'HLS',  color: '#6d5efc', bg: '#f1effe' },
    dash: { label: 'DASH', color: '#0e9bb8', bg: '#e3f6fa' },
    file: { label: 'FILE', color: '#15a35b', bg: '#e6f6ed' },
    unknown: { label: '???', color: '#8a8f9a', bg: '#f1f2f5' },
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; }
  .root { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; }
  .launcher {
    display: flex; align-items: center; gap: 9px; cursor: pointer; user-select: none;
    padding: 9px 15px 9px 11px; border-radius: 999px; color: #fff; border: none;
    background: #6d5efc; box-shadow: 0 6px 20px rgba(109,94,252,.32);
    transition: transform .16s ease, box-shadow .16s ease; font-size: 13px; font-weight: 600;
  }
  .launcher:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(109,94,252,.42); }
  .launcher svg { width: 17px; height: 17px; }
  .count { background: rgba(255,255,255,.26); border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 700; min-width: 20px; text-align: center; }
  .panel {
    position: absolute; right: 0; bottom: 58px; width: 344px; max-height: 72vh; overflow: hidden;
    display: flex; flex-direction: column; border-radius: 16px; color: #16181d;
    background: #fff; border: 1px solid #e0e1e7;
    box-shadow: 0 16px 48px rgba(22,24,29,.18);
    opacity: 0; transform: translateY(8px) scale(.99); pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
  .head { display: flex; align-items: center; gap: 10px; padding: 15px 16px 14px; border-bottom: 1px solid #ececf0; }
  .logo { width: 24px; height: 24px; border-radius: 7px; background: #6d5efc; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .logo svg { width: 14px; height: 14px; color: #fff; }
  .titles { flex: 1; min-width: 0; }
  .titles h1 { font-size: 14px; font-weight: 650; letter-spacing: -.2px; }
  .titles p { font-size: 11px; color: #9aa0ac; margin-top: 1px; }
  .iconbtn { background: transparent; border: none; color: #9aa0ac; cursor: pointer; padding: 5px; border-radius: 7px; line-height: 0; transition: background .14s, color .14s; }
  .iconbtn:hover { color: #16181d; background: #f6f6f9; }
  .body { overflow-y: auto; padding: 4px 16px; }
  .empty { text-align: center; padding: 38px 10px 36px; color: #9aa0ac; font-size: 12.5px; line-height: 1.5; }
  .empty .pulse {
    width: 44px; height: 44px; margin: 0 auto 14px; border-radius: 50%;
    border: 2px solid #f1effe; position: relative;
  }
  .empty .pulse::before {
    content: ''; position: absolute; inset: -2px; border-radius: 50%;
    border: 2px solid transparent; border-top-color: #6d5efc;
    animation: spin 1.5s linear infinite;
  }
  .empty .pulse svg { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .card {
    display: flex; align-items: center; gap: 11px; padding: 13px 2px;
    border-bottom: 1px solid #ececf0;
  }
  .card:last-child { border-bottom: none; }
  .chip { font-size: 10px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; padding: 2px 6px; border-radius: 5px; flex-shrink: 0; }
  .meta { flex: 1; min-width: 0; }
  .meta .name { font-size: 13px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta .sub { font-size: 11.5px; color: #9aa0ac; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .dl { flex-shrink: 0; width: 32px; height: 32px; border-radius: 8px; border: none; cursor: pointer; color: #fff;
    background: #6d5efc; display: flex; align-items: center; justify-content: center;
    transition: background .14s ease; }
  .dl:hover { background: #5847e8; }
  .dl-off { background: #c7c9d1; cursor: not-allowed; }
  .dl-off:hover { background: #c7c9d1; }
  .dl svg { width: 15px; height: 15px; }
  .foot { padding: 12px 16px 14px; border-top: 1px solid #ececf0; }
  .allbtn { width: 100%; padding: 11px; border-radius: 10px; border: none; cursor: pointer;
    background: #6d5efc; color: #fff; font-size: 13px; font-weight: 600; transition: background .14s ease; }
  .allbtn:hover { background: #5847e8; }
  .toast { position: absolute; right: 0; bottom: 58px; width: 300px; padding: 13px 14px 13px 32px; border-radius: 12px;
    background: #fff; border: 1px solid #e0e1e7; color: #16181d; font-size: 12.5px;
    box-shadow: 0 12px 34px rgba(22,24,29,.16); opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s;
    pointer-events: none; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast .dot { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 8px; height: 8px; border-radius: 50%; background: #6d5efc; }
  .toast.ok .dot { background: #15a35b; } .toast.err .dot { background: #e0443e; }
  `;

  const icon = {
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12 19 5"/><circle cx="12" cy="12" r="3"/></svg>',
  };

  const ui = {
    streams: [], injected: [], series: null, open: false, toastTimer: null,
    build() {
      this.host = document.createElement('div');
      this.host.id = 'siphon-root';
      const sr = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style'); style.textContent = CSS; sr.appendChild(style);
      const root = document.createElement('div'); root.className = 'root'; sr.appendChild(root);

      this.panel = document.createElement('div'); this.panel.className = 'panel';
      this.panel.innerHTML = `
        <div class="head">
          <div class="logo">${icon.down}</div>
          <div class="titles"><h1>Siphon</h1><p class="sub">Scanning for streams…</p></div>
          <button class="iconbtn" data-act="close" title="Close">${icon.close}</button>
        </div>
        <div class="body"></div>
        <div class="foot" style="display:none"></div>`;
      root.appendChild(this.panel);

      this.launcher = document.createElement('button'); this.launcher.className = 'launcher';
      this.launcher.innerHTML = `${icon.down}<span class="lbl">Siphon</span><span class="count" style="display:none">0</span>`;
      root.appendChild(this.launcher);

      this.toast = document.createElement('div'); this.toast.className = 'toast';
      this.toast.innerHTML = `<span class="dot"></span><span class="msg"></span>`;
      root.appendChild(this.toast);

      this.bodyEl = this.panel.querySelector('.body');
      this.footEl = this.panel.querySelector('.foot');
      this.subEl = this.panel.querySelector('.sub');
      this.countEl = this.launcher.querySelector('.count');

      this.launcher.addEventListener('click', () => this.toggle());
      this.panel.querySelector('[data-act="close"]').addEventListener('click', () => this.toggle(false));

      (document.body || document.documentElement).appendChild(this.host);
      this.render();
    },
    toggle(force) {
      this.open = force === undefined ? !this.open : force;
      this.panel.classList.toggle('open', this.open);
      if (this.open) this.refresh();
    },
    refresh() { send({ type: MSG.GET_STREAMS }).then((r) => { if (r && r.ok) this.setStreams(r.streams); }).catch(() => {}); },
    setStreams(streams) {
      this.streams = Array.isArray(streams) ? streams : [];
      this.render();
    },
    setSeries(series) { this.series = series; this.render(); },
    setInjected(list) { this.injected = Array.isArray(list) ? list : []; this.render(); },
    visible() { return this.streams.length > 0 || this.injected.length > 0 || (this.series && this.series.episodesApiUrls && this.series.episodesApiUrls.length); },
    render() {
      if (!this.host) return;
      this.host.style.display = this.visible() ? 'block' : 'none';
      // When we resolve the real media ourselves (Instagram), the passive detector
      // also catches audio tracks and tiny range-probe fragments — noise. If we have
      // resolved videos, show only those; otherwise show sniffed streams.
      const all = this.injected.length ? this.injected.slice() : this.streams.slice();
      const n = all.length;
      this.countEl.style.display = n ? 'inline-block' : 'none';
      this.countEl.textContent = String(n);
      this.subEl.textContent = n ? `${n} stream${n > 1 ? 's' : ''} found` : 'Scanning for streams…';

      if (!n) {
        this.bodyEl.innerHTML = `<div class="empty"><div class="pulse">${icon.radar}</div>Watching network traffic.<br>Play the video to reveal its stream.</div>`;
      } else {
        this.bodyEl.innerHTML = '';
        for (const s of all) {
          const k = KIND[s.kind] || KIND.unknown;
          const isDash = s.kind === 'dash';
          const card = document.createElement('div'); card.className = 'card';
          const size = s.bytes ? ' · ' + (s.bytes / 1048576).toFixed(1) + ' MB' : '';
          const btnTitle = isDash ? 'DASH (.mpd) needs the yt-dlp companion (not installed yet)' : 'Download';
          card.innerHTML = `
            <span class="chip" style="background:${k.bg};color:${k.color}">${k.label}</span>
            <div class="meta"><div class="name">${escapeHtml(s.name)}</div><div class="sub">${escapeHtml(s.host)}${size}</div></div>
            <button class="dl${isDash ? ' dl-off' : ''}"${isDash ? ' disabled' : ''} title="${btnTitle}">${icon.down}</button>`;
          if (!isDash) card.querySelector('.dl').addEventListener('click', () => this.download(s));
          this.bodyEl.appendChild(card);
        }
      }

      const hasSeries = this.series && this.series.episodesApiUrls && this.series.episodesApiUrls.length;
      this.footEl.style.display = hasSeries ? 'block' : 'none';
      if (hasSeries) {
        this.footEl.innerHTML = `<button class="allbtn">⬇ Download all episodes</button>`;
        this.footEl.querySelector('.allbtn').addEventListener('click', () => this.downloadAll());
      }
    },
    download(s) {
      try { document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} }); } catch {}
      const title = (s.dlTitle || document.title || s.name || 'video').trim();
      this.showToast('Starting download…', '');
      send({ type: MSG.DOWNLOAD_STREAM, stream: s, title }).catch((e) => this.showToast('Error: ' + (e && e.message || e), 'err'));
    },
    downloadAll() {
      if (!this.series) return;
      try { document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} }); } catch {}
      const title = (document.title || 'video').trim();
      this.showToast('Starting all episodes…', '');
      send({ type: MSG.DOWNLOAD_ALL_EPISODES, episodesApiUrls: this.series.episodesApiUrls, title }).catch((e) => this.showToast('Error: ' + (e && e.message || e), 'err'));
    },
    onStatus(p) {
      if (p.state === 'downloading') {
        const label = p.total ? `Episode ${p.episode} (${p.current}/${p.total})…` : (p.note || 'Downloading…');
        this.showToast(label, '', 4000);
      }
      else if (p.state === 'done') this.showToast(p.filename ? `Saved ${p.filename}` : (p.failed && p.failed.length ? `Done. Failed: ${p.failed.join(', ')}` : 'Download complete'), 'ok');
      else if (p.state === 'failed') this.showToast('Failed: ' + (p.error || 'unknown'), 'err');
    },
    showToast(msg, cls, ms = 3500) {
      this.toast.className = 'toast show ' + (cls || '');
      this.toast.querySelector('.msg').textContent = msg;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toast.className = 'toast ' + (cls || ''); }, ms);
    },
  };

  function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // boot
  function boot() {
    if (!ctxOk()) return;
    ui.build();
    ui.refresh();
    // chartdrama.com: resolve the series straight from its API.
    chartdramaSeries().then((cs) => { if (cs) ui.setSeries(cs); });
    { const igv = instagramVideos(); if (igv.length) ui.setInjected(igv); }
    // generic fallback for other sites (scrape m3u8 + episodes API from the DOM).
    const meta = scanPageMeta();
    if (meta.episodesApiUrls && meta.episodesApiUrls.length && !ui.series) ui.setSeries(meta);
    // re-scan: SPA route changes (new drama) and late-appearing series APIs.
    setInterval(() => {
      if (!ctxOk()) { if (ui.host) ui.host.remove(); return; }
      chartdramaSeries().then((cs) => {
        if (cs && (!ui.series || ui.series.dramaId !== cs.dramaId)) ui.setSeries(cs);
      });
      const m = scanPageMeta();
      if (m.episodesApiUrls && m.episodesApiUrls.length && !ui.series) ui.setSeries(m);
      const iv = instagramVideos();
      const cur = ui.injected || [];
      if (iv.length && (iv.length !== cur.length || (iv[0] && cur[0] && iv[0].url !== cur[0].url) || !cur.length)) ui.setInjected(iv);
    }, 3000);
  }
  if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
})();
