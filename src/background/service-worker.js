import { MSG, StreamKind } from '../shared/messages.js';
import { loadHlsPlaylist } from '../core/hls-loader.js';
import { segmentsInInterval, estimateSegmentCount, clampInterval, totalDuration } from '../core/segment-manager.js';
import DownloadManager, { JobState } from '../core/download-manager.js';
import VideoAssembler from '../core/video-assembler.js';
import { initDetector, list as listStreams, clear as clearStreams, setNotifier } from './detector.js';

const dm = new DownloadManager({
  onProgress: (u) => {
    chrome.runtime.sendMessage({ type: MSG.JOB_UPDATE, payload: u }).catch(() => {});
  },
});

// Start passive network detection as soon as the worker loads.
initDetector();
// Forward detected streams to the page overlay. runtime.sendMessage (used inside
// the detector) reaches extension pages like the popup, but NOT content scripts;
// content scripts must be messaged via tabs.sendMessage.
setNotifier((tabId, streams) => {
  if (!tabId || tabId < 0) return;
  chrome.tabs.sendMessage(tabId, { type: MSG.STREAMS_UPDATED, tabId, streams }).catch(() => {});
});

chrome.action.setBadgeTextColor?.({ color: '#ffffff' });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(name) {
  return String(name || 'video').replace(/[\\/:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';
}

// Download status must reach BOTH the popup (runtime.sendMessage) and the page
// overlay (tabs.sendMessage — runtime messages never reach content scripts).
function emitStatus(tabId, payload) {
  const msg = { type: MSG.DOWNLOAD_ALL_STATUS, payload };
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  if (tabId && tabId > 0) { try { chrome.tabs.sendMessage(tabId, msg).catch(() => {}); } catch {} }
}


function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function jobResultToBytes(job) {
  const ordered = job.segments
    .map((seg) => job.results.get(seg.index != null ? seg.index : seg.url))
    .filter(Boolean);
  const total = ordered.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of ordered) { out.set(new Uint8Array(b), off); off += b.byteLength; }
  return out;
}

async function prependInit(bytes, initUrl) {
  if (!initUrl) return bytes;
  try {
    const r = await fetch(initUrl, { credentials: 'include' });
    if (!r.ok) return bytes;
    const ibuf = new Uint8Array(await r.arrayBuffer());
    const merged = new Uint8Array(ibuf.byteLength + bytes.length);
    merged.set(ibuf, 0);
    merged.set(bytes, ibuf.byteLength);
    return merged;
  } catch { return bytes; }
}

// Download an HLS stream (whole, or a [start,end] interval) and save it.
async function downloadHls(url, filenameBase, opts = {}) {
  const playlist = await loadHlsPlaylist(fetch, url);
  if (!playlist || !Array.isArray(playlist.segments) || !playlist.segments.length) {
    throw new Error('No segments found in playlist');
  }
  let segs = playlist.segments;
  if (Number.isFinite(opts.start) || Number.isFinite(opts.end)) {
    segs = segmentsInInterval(playlist.segments, opts.start ?? 0, opts.end ?? playlist.totalDuration);
    if (!segs.length) throw new Error('Selected range contains no segments');
  }
  const job = dm.createJob({
    segments: segs,
    maxBytes: opts.maxBytes || Infinity,
    concurrency: opts.concurrency || 5,
    initSegmentUrl: playlist.initSegmentUrl,
    meta: opts.meta || null,
  });
  const finished = await dm.runJob(job);
  if (finished.state !== JobState.COMPLETED) {
    dm.jobs.delete(job.id);
    throw new Error('Download ' + finished.state + (finished.error ? ': ' + finished.error : ''));
  }
  let bytes = jobResultToBytes(job);
  bytes = await prependInit(bytes, playlist.initSegmentUrl);
  dm.jobs.delete(job.id); // free memory

  const isMp4 = !!playlist.initSegmentUrl || /\.mp4(\?|$)/i.test(playlist.segments[0]?.url || '');
  const ext = isMp4 ? 'mp4' : 'ts';
  const mime = isMp4 ? 'video/mp4' : 'video/mp2t';
  const filename = sanitizeFilename(filenameBase) + '.' + ext;
  const dataUrl = 'data:' + mime + ';base64,' + bytesToBase64(bytes);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return { filename, bytes: bytes.length };
}

// Download a direct media file (mp4/webm/...).
async function downloadFile(url, filenameBase) {
  const extMatch = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
  const filename = sanitizeFilename(filenameBase) + '.' + ext;
  await chrome.downloads.download({ url, filename, saveAs: false });
  return { filename };
}

async function downloadStream(stream, title, meta = null) {
  const base = title || stream.name || 'video';
  if (stream.kind === StreamKind.HLS) return downloadHls(stream.url, base, { ...(stream.opts || {}), meta });
  if (stream.kind === StreamKind.FILE) return downloadFile(stream.url, base);
  if (stream.kind === StreamKind.DASH) throw new Error('DASH (.mpd) download is coming soon. HLS and direct files work now.');
  throw new Error('Unknown stream type');
}

// ---------------------------------------------------------------------------
// episodes (series bulk download) — unchanged logic, reuses downloadHls
// ---------------------------------------------------------------------------

async function fetchEpisodesListForAll(apiUrls) {
  // chartdrama's /api/drama/{id}/episodes returns the whole series in one call,
  // so we just fetch each given URL once and dedupe by episode number.
  const candidates = new Set(apiUrls || []);
  const merged = [];
  const seen = new Set();
  for (const u of candidates) {
    try {
      const res = await fetch(u, { credentials: 'include' });
      if (!res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      for (const item of items) {
        const key = item.ep != null ? `ep:${item.ep}` : item.url;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    } catch {}
  }
  merged.sort((a, b) => (a.ep || 0) - (b.ep || 0));
  return merged;
}

// chartdrama's bulk /episodes list caches signed URLs: only the currently-watched
// episode stays fresh, the rest carry a stale signature and 403. Each episode can
// be re-signed on demand via /api/drama/{id}/refresh-episode?ep=N (no auth). Returns
// the refresh endpoint base if these are chartdrama episode APIs, else null.
function chartdramaRefreshBase(apiUrls) {
  for (const u of (apiUrls || [])) {
    try {
      const url = new URL(u);
      const m = url.pathname.match(/^\/api\/drama\/(\d+)\/episodes\/?$/);
      if (m && /(^|\.)chartdrama\.com$/i.test(url.hostname)) return `${url.origin}/api/drama/${m[1]}/refresh-episode`;
    } catch {}
  }
  return null;
}

async function freshEpisodeUrl(refreshBase, ep, fallback) {
  if (!refreshBase || ep == null) return fallback;
  try {
    const r = await fetch(`${refreshBase}?ep=${encodeURIComponent(ep)}`);
    if (r.ok) { const j = await r.json(); if (j && j.url) return j.url; }
  } catch {}
  return fallback;
}

async function downloadAllEpisodesInBackground(episodesApiUrls, titleBase, tabId = null) {
  try { chrome.alarms.create('sg-keepalive', { periodInMinutes: 0.5 }); } catch {}
  try {
    const list = await fetchEpisodesListForAll(episodesApiUrls);
    if (!list.length) {
      emitStatus(tabId, { state: 'failed', error: 'No episodes found.' });
      return;
    }
    const refreshBase = chartdramaRefreshBase(episodesApiUrls);
    const failed = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      emitStatus(tabId, { current: i + 1, total: list.length, episode: item.ep, state: 'downloading' });
      try {
        // bulk-list URLs for every episode but the current one are stale (403);
        // re-sign each one just before downloading it.
        const url = await freshEpisodeUrl(refreshBase, item.ep, item.url || '');
        const epNum = item.ep != null ? String(item.ep).padStart(2, '0') : String(i + 1).padStart(2, '0');
        const base = `${titleBase || 'video'} - E${epNum}`;
        if (/\.m3u8(\?|$)/i.test(url)) await downloadHls(url, base);
        else await downloadFile(url, base);
      } catch (e) {
        failed.push(item.ep);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    emitStatus(tabId, { state: 'done', failed });
  } catch (e) {
    emitStatus(tabId, { state: 'failed', error: String(e?.message || e) });
  } finally {
    try { chrome.alarms.clear('sg-keepalive'); } catch {}
  }
}

chrome.alarms.onAlarm.addListener(() => {});

// ---------------------------------------------------------------------------
// right-click context menu: download the whole series or just this video
// ---------------------------------------------------------------------------

const CTX = { urls: ['http://*/*', 'https://*/*'] };
function buildContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'siphon-series', title: 'Siphon ⬇  Download whole series', contexts: ['page', 'video', 'link', 'frame', 'selection'], documentUrlPatterns: CTX.urls });
    chrome.contextMenus.create({ id: 'siphon-video', title: 'Siphon ⬇  Download this video', contexts: ['page', 'video', 'link', 'frame'], documentUrlPatterns: CTX.urls });
  });
}
chrome.runtime.onInstalled.addListener(buildContextMenus);
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(buildContextMenus);
buildContextMenus();

function bestHlsStream(tabId) {
  const streams = listStreams(tabId) || [];
  return streams.find((s) => s.kind === StreamKind.HLS) || streams.find((s) => s.kind === StreamKind.FILE) || streams[0] || null;
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const tabId = tab && tab.id;
    if (!tabId) return;
    // Resolve series + title from the content script (works on chartdrama and
    // any site that exposes episodesApiUrls; falls back to sniffed streams).
    let page = null;
    try { page = await chrome.tabs.sendMessage(tabId, { type: MSG.DETECT_VIDEO }); } catch {}
    const title = (page && page.title) || (tab && tab.title) || 'video';

    if (info.menuItemId === 'siphon-series') {
      const apis = page && page.episodesApiUrls;
      if (apis && apis.length) {
        emitStatus(tabId, { state: 'downloading', current: 0, total: 0, episode: '', note: 'Resolving episodes…' });
        downloadAllEpisodesInBackground(apis, title, tabId);
        return;
      }
      // No series API — fall back to the single detected stream.
    }

    // Single video (or series fallback): download the best detected stream.
    const stream = bestHlsStream(tabId);
    if (!stream) {
      emitStatus(tabId, { state: 'failed', error: 'No downloadable video detected yet. Start playback, then try again.' });
      return;
    }
    emitStatus(tabId, { state: 'downloading', current: 1, total: 1, episode: '', note: 'Downloading…' });
    try {
      const r = await downloadStream(stream, title);
      emitStatus(tabId, { state: 'done', filename: r.filename });
    } catch (e) {
      emitStatus(tabId, { state: 'failed', error: String(e && e.message || e) });
    }
  });
}


// ---------------------------------------------------------------------------
// message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const tabId = (msg && msg.tabId) || (sender.tab && sender.tab.id);
      switch (msg && msg.type) {
        case MSG.GET_STREAMS: {
          sendResponse({ ok: true, streams: listStreams(tabId) });
          break;
        }
        case MSG.CLEAR_STREAMS: {
          clearStreams(tabId);
          sendResponse({ ok: true });
          break;
        }
        case MSG.DETECT_VIDEO: {
          // Ask the content script, then merge with sniffed streams.
          let res = null;
          if (tabId) {
            try { res = await chrome.tabs.sendMessage(tabId, { type: MSG.DETECT_VIDEO }); } catch {}
          }
          sendResponse({ ok: true, page: res && res.ok ? res : null, streams: listStreams(tabId) });
          break;
        }
        case MSG.FETCH_EPISODES: {
          if (!msg.url) throw new Error('Missing episodes url');
          const res = await fetch(msg.url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          sendResponse({ ok: true, data: await res.json() });
          break;
        }
        case MSG.FETCH_PLAYLIST: {
          if (!msg.url) throw new Error('Missing playlist url');
          sendResponse({ ok: true, playlist: await loadHlsPlaylist(fetch, msg.url) });
          break;
        }
        case MSG.DOWNLOAD_STREAM: {
          (async () => {
            try {
              const meta = msg.clientId ? { clientId: msg.clientId } : null;
              const r = await downloadStream(msg.stream, msg.title, meta);
              emitStatus(tabId, { state: 'done', filename: r.filename, clientId: msg.clientId });
            } catch (e) {
              emitStatus(tabId, { state: 'failed', error: String(e?.message || e), clientId: msg.clientId });
            }
          })();
          sendResponse({ ok: true, started: true });
          break;
        }
        case MSG.DOWNLOAD_ALL_EPISODES: {
          downloadAllEpisodesInBackground(msg.episodesApiUrls, msg.title || 'video', tabId);
          sendResponse({ ok: true, started: true });
          break;
        }
        case MSG.START_DOWNLOAD: {
          const job = dm.createJob({
            segments: msg.segments,
            maxBytes: msg.maxBytes,
            concurrency: msg.concurrency || 5,
            initSegmentUrl: msg.initSegmentUrl,
          });
          dm.runJob(job).then((j) => {
            chrome.runtime.sendMessage({ type: MSG.JOB_UPDATE, payload: { id: j.id, state: j.state, progress: j.progress, error: j.error } }).catch(() => {});
          });
          sendResponse({ ok: true, jobId: job.id });
          break;
        }
        case MSG.JOB_CANCEL: { dm.cancelJob(msg.jobId); sendResponse({ ok: true }); break; }
        case MSG.JOB_PAUSE: { dm.pauseJob(msg.jobId); sendResponse({ ok: true }); break; }
        case MSG.JOB_RESUME: { dm.resumeJob(msg.jobId); sendResponse({ ok: true }); break; }
        case MSG.GET_JOB_RESULT: {
          const job = dm.getJob(msg.jobId);
          if (!job) throw new Error('Job not found');
          if (job.state !== JobState.COMPLETED) throw new Error('Job not completed');
          let bytes = jobResultToBytes(job);
          const initUrl = job.initSegmentUrl;
          bytes = await prependInit(bytes, initUrl);
          const isMp4 = !!initUrl || /\.mp4(\?|$)/i.test(job.segments[0]?.url || '');
          const filename = isMp4 ? 'siphon.mp4' : 'siphon.ts';
          const base64 = bytesToBase64(bytes);
          dm.jobs.delete(job.id); // free memory after handing off
          sendResponse({ ok: true, base64, filename });
          break;
        }
        case MSG.OPEN_POPUP: {
          if (chrome.action?.openPopup) {
            chrome.action.openPopup().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
          } else sendResponse({ ok: false, error: 'openPopup not supported' });
          return;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

export { segmentsInInterval, estimateSegmentCount, clampInterval, totalDuration, VideoAssembler };
