// Universal stream detector.
//
// Passively observes network traffic per tab via chrome.webRequest and
// classifies media manifests / files. This is far more reliable than scraping
// page HTML: it catches HLS (.m3u8), DASH (.mpd) and direct media (mp4/webm/...)
// regardless of how the player loads them (fetch, XHR, <video>, MSE).
//
// It keeps a per-tab registry, updates the toolbar badge, and notifies the UI.

import { StreamKind } from '../shared/messages.js';

const MANIFEST_RE = /\.m3u8(\?|#|$)/i;
const DASH_RE = /\.mpd(\?|#|$)/i;
const FILE_RE = /\.(mp4|webm|mkv|mov|m4v|m4a|mp3|flv|ogg|ts)(\?|#|$)/i;
const SEGMENT_RE = /\.(ts|m4s|aac|vtt)(\?|#|$)/i;

const CT_MAP = [
  [/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i, StreamKind.HLS],
  [/application\/dash\+xml/i, StreamKind.DASH],
  [/video\/(mp4|webm|x-matroska|quicktime)/i, StreamKind.FILE],
  [/audio\/(mpeg|mp4|aac|ogg)/i, StreamKind.FILE],
];

// tabId -> Map<normalizedUrl, stream>
const registry = new Map();
let notifyFn = null;

function host(u) {
  try { return new URL(u).host; } catch { return ''; }
}

function fileName(u) {
  try {
    const p = new URL(u).pathname;
    const base = p.split('/').filter(Boolean).pop() || host(u) || 'stream';
    return decodeURIComponent(base);
  } catch { return 'stream'; }
}

function classify(url, contentType) {
  if (contentType) {
    for (const [re, kind] of CT_MAP) if (re.test(contentType)) return kind;
  }
  if (MANIFEST_RE.test(url)) return StreamKind.HLS;
  if (DASH_RE.test(url)) return StreamKind.DASH;
  if (FILE_RE.test(url) && !SEGMENT_RE.test(url)) return StreamKind.FILE;
  return StreamKind.UNKNOWN;
}

function tabMap(tabId) {
  let m = registry.get(tabId);
  if (!m) { m = new Map(); registry.set(tabId, m); }
  return m;
}

function keyFor(url) {
  // Collapse query for manifests so re-requests with changing tokens dedupe,
  // but keep full URL so we can still fetch (store original separately).
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }
}

function add(tabId, url, kind, extra = {}) {
  if (!tabId || tabId < 0) return;
  if (kind === StreamKind.UNKNOWN) return;
  const m = tabMap(tabId);
  const key = keyFor(url);
  const existing = m.get(key);
  const stream = {
    id: key,
    url,                       // freshest full URL (with tokens)
    kind,
    name: fileName(url),
    host: host(url),
    firstSeen: existing ? existing.firstSeen : Date.now(),
    lastSeen: Date.now(),
    hits: existing ? existing.hits + 1 : 1,
    ...existing,
    ...extra,
  };
  stream.url = url;            // always refresh token
  stream.lastSeen = Date.now();
  stream.kind = kind;
  m.set(key, stream);
  updateBadge(tabId);
  notify(tabId);
}

function updateBadge(tabId) {
  const n = count(tabId);
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d5efc' });
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  } catch {}
}

let notifyTimer = null;
function notify(tabId) {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const streams = list(tabId);
    if (typeof notifyFn === 'function') notifyFn(tabId, streams);
    try { chrome.runtime.sendMessage({ type: 'STREAMS_UPDATED', tabId, streams }).catch(() => {}); } catch {}
  }, 150);
}

export function count(tabId) {
  const m = registry.get(tabId);
  return m ? m.size : 0;
}

export function list(tabId) {
  const m = registry.get(tabId);
  if (!m) return [];
  return Array.from(m.values()).sort((a, b) => {
    const rank = { hls: 0, dash: 1, file: 2, unknown: 3 };
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    return b.lastSeen - a.lastSeen;
  });
}

export function clear(tabId) {
  registry.delete(tabId);
  updateBadge(tabId);
  notify(tabId);
}

export function setNotifier(fn) { notifyFn = fn; }

export function initDetector() {
  const filter = { urls: ['http://*/*', 'https://*/*'] };

  // URL-pattern pass (fast): catches obvious manifests/files on request.
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    const kind = classify(d.url, null);
    if (kind !== StreamKind.UNKNOWN) add(d.tabId, d.url, kind);
  }, filter);

  // Content-Type pass (accurate): catches extension-less manifests/files.
  if (chrome.webRequest.onHeadersReceived) {
    chrome.webRequest.onHeadersReceived.addListener((d) => {
      const h = (d.responseHeaders || []).find((x) => x.name && x.name.toLowerCase() === 'content-type');
      const ct = h ? h.value : '';
      const kind = classify(d.url, ct);
      if (kind !== StreamKind.UNKNOWN && !SEGMENT_RE.test(d.url)) {
        const extra = {};
        const len = (d.responseHeaders || []).find((x) => x.name && x.name.toLowerCase() === 'content-length');
        if (len && Number(len.value) > 0) extra.bytes = Number(len.value);
        add(d.tabId, d.url, kind, extra);
      }
    }, filter, ['responseHeaders']);
  }

  // Reset a tab's registry when it navigates to a new page.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) clear(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => { registry.delete(tabId); });
}

export default { initDetector, list, count, clear, setNotifier };
