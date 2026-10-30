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
    hls:  { label: 'HLS',  color: '#6d5efc' },
    dash: { label: 'DASH', color: '#00b8d4' },
    file: { label: 'FILE', color: '#22c55e' },
    unknown: { label: '???', color: '#94a3b8' },
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .root { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; }
  .launcher {
    display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
    padding: 10px 14px; border-radius: 999px; color: #fff; border: none;
    background: linear-gradient(135deg, #6d5efc 0%, #a855f7 100%);
    box-shadow: 0 8px 24px rgba(109,94,252,.45), 0 2px 6px rgba(0,0,0,.3);
    transition: transform .18s ease, box-shadow .18s ease; font-size: 13px; font-weight: 600;
  }
  .launcher:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(109,94,252,.55); }
  .launcher svg { width: 18px; height: 18px; }
  .count { background: rgba(255,255,255,.25); border-radius: 999px; padding: 1px 8px; font-size: 12px; min-width: 20px; text-align: center; }
  .panel {
    position: absolute; right: 0; bottom: 56px; width: 340px; max-height: 70vh; overflow: hidden;
    display: flex; flex-direction: column; border-radius: 16px; color: #e8eaf2;
    background: rgba(18,18,28,.82); backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    border: 1px solid rgba(255,255,255,.1); box-shadow: 0 20px 60px rgba(0,0,0,.55);
    opacity: 0; transform: translateY(10px) scale(.98); pointer-events: none;
    transition: opacity .2s ease, transform .2s ease;
  }
  .panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
  .head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .logo { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg,#6d5efc,#a855f7); display: flex; align-items: center; justify-content: center; }
  .logo svg { width: 16px; height: 16px; color: #fff; }
  .titles { flex: 1; min-width: 0; }
  .titles h1 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: .2px; }
  .titles p { margin: 2px 0 0; font-size: 11px; color: #9aa0b4; }
  .iconbtn { background: transparent; border: none; color: #9aa0b4; cursor: pointer; padding: 4px; border-radius: 6px; line-height: 0; }
  .iconbtn:hover { color: #fff; background: rgba(255,255,255,.08); }
  .body { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .empty { text-align: center; padding: 28px 16px; color: #9aa0b4; font-size: 13px; line-height: 1.5; }
  .empty .pulse { width: 40px; height: 40px; margin: 0 auto 10px; border-radius: 50%; background: rgba(109,94,252,.18); display: flex; align-items: center; justify-content: center; animation: pulse 1.8s ease infinite; }
  .empty .pulse svg { width: 20px; height: 20px; color: #6d5efc; }
  @keyframes pulse { 0%,100% { transform: scale(1); opacity: .7; } 50% { transform: scale(1.12); opacity: 1; } }
  .card {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06);
    transition: background .15s ease, border-color .15s ease;
  }
  .card:hover { background: rgba(255,255,255,.07); border-color: rgba(109,94,252,.5); }
  .chip { font-size: 10px; font-weight: 800; letter-spacing: .5px; padding: 4px 7px; border-radius: 6px; color: #fff; flex-shrink: 0; }
  .meta { flex: 1; min-width: 0; }
  .meta .name { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta .sub { font-size: 11px; color: #9aa0b4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .dl { flex-shrink: 0; width: 34px; height: 34px; border-radius: 9px; border: none; cursor: pointer; color: #fff;
    background: linear-gradient(135deg,#6d5efc,#a855f7); display: flex; align-items: center; justify-content: center;
    transition: transform .15s ease, filter .15s ease; }
  .dl:hover { transform: scale(1.08); filter: brightness(1.1); }
  .dl svg { width: 16px; height: 16px; }
  .foot { padding: 10px 12px; border-top: 1px solid rgba(255,255,255,.08); }
  .allbtn { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid rgba(109,94,252,.5); cursor: pointer;
    background: rgba(109,94,252,.14); color: #cfc8ff; font-size: 12.5px; font-weight: 600; transition: background .15s ease; }
  .allbtn:hover { background: rgba(109,94,252,.26); }
  .toast { position: absolute; right: 0; bottom: 56px; width: 300px; padding: 12px 14px; border-radius: 12px;
    background: rgba(18,18,28,.95); border: 1px solid rgba(255,255,255,.12); color: #e8eaf2; font-size: 12.5px;
    box-shadow: 0 16px 40px rgba(0,0,0,.5); opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s;
    pointer-events: none; display: flex; align-items: center; gap: 10px; }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast .dot { width: 8px; height: 8px; border-radius: 50%; background: #6d5efc; flex-shrink: 0; }
  .toast.ok .dot { background: #22c55e; } .toast.err .dot { background: #ef4444; }
  `;

  const icon = {
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    radar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12 19 5"/><circle cx="12" cy="12" r="3"/></svg>',
  };

  const ui = {
    streams: [], series: null, open: false, toastTimer: null,
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
    visible() { return this.streams.length > 0 || (this.series && this.series.episodesApiUrls && this.series.episodesApiUrls.length); },
    render() {
      if (!this.host) return;
      this.host.style.display = this.visible() ? 'block' : 'none';
      const n = this.streams.length;
      this.countEl.style.display = n ? 'inline-block' : 'none';
      this.countEl.textContent = String(n);
      this.subEl.textContent = n ? `${n} stream${n > 1 ? 's' : ''} found` : 'Scanning for streams…';

      if (!n) {
        this.bodyEl.innerHTML = `<div class="empty"><div class="pulse">${icon.radar}</div>Watching network traffic.<br>Play the video to reveal its stream.</div>`;
      } else {
        this.bodyEl.innerHTML = '';
        for (const s of this.streams) {
          const k = KIND[s.kind] || KIND.unknown;
          const card = document.createElement('div'); card.className = 'card';
          const size = s.bytes ? ' · ' + (s.bytes / 1048576).toFixed(1) + ' MB' : '';
          card.innerHTML = `
            <span class="chip" style="background:${k.color}">${k.label}</span>
            <div class="meta"><div class="name">${escapeHtml(s.name)}</div><div class="sub">${escapeHtml(s.host)}${size}</div></div>
            <button class="dl" title="Download">${icon.down}</button>`;
          card.querySelector('.dl').addEventListener('click', () => this.download(s));
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
      const title = (document.title || s.name || 'video').trim();
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
      if (p.state === 'downloading') this.showToast(`Episode ${p.episode} (${p.current}/${p.total})…`, '', 4000);
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
    }, 3000);
  }
  if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
})();
