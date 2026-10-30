import { MSG, StreamKind } from '../shared/messages.js';
import { segmentsInInterval, estimateSegmentCount, clampInterval } from '../core/segment-manager.js';
import { formatTime } from '../shared/utils.js';

const $ = (id) => document.getElementById(id);

let currentTabId = null;
let streams = [];               // detected streams for this tab
const cards = new Map();        // stream.id -> { li, bar, barWrap, status, btn }
const clientToStream = new Map(); // clientId -> stream.id

// series (page detection)
let episodesApiUrls = [];
let seriesTitle = '';

// advanced manual flow
let playlist = null;
let selectedSegments = [];
let currentJobId = null;
let manualFilename = 'video';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0].id : null;
}

function toast(text, kind) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function sanitize(name) {
  return String(name || 'video').replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
}

function kindClass(kind) {
  return 'kind-' + (kind || StreamKind.UNKNOWN);
}

function prettyName(s) {
  let n = s.name || s.host || 'stream';
  n = n.split('?')[0];
  if (n.length > 42) n = n.slice(0, 39) + '...';
  return n;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function render() {
  const list = $('streamList');
  const empty = $('emptyState');
  const pill = $('countPill');

  if (!streams.length) {
    empty.hidden = false;
    list.innerHTML = '';
    cards.clear();
    pill.hidden = true;
    return;
  }
  empty.hidden = true;
  pill.hidden = false;
  pill.textContent = String(streams.length);

  // remove cards for streams no longer present
  const ids = new Set(streams.map((s) => s.id));
  for (const [id, c] of cards) {
    if (!ids.has(id)) { c.li.remove(); cards.delete(id); }
  }
  // add / keep
  for (const s of streams) {
    if (!cards.has(s.id)) list.appendChild(makeCard(s));
  }
}

function makeCard(stream) {
  const li = document.createElement('li');
  li.className = 'stream-card';

  const head = document.createElement('div');
  head.className = 'sc-head';
  const chip = document.createElement('span');
  chip.className = 'kind-chip ' + kindClass(stream.kind);
  chip.textContent = stream.kind;
  const name = document.createElement('span');
  name.className = 'sc-name';
  name.textContent = prettyName(stream);
  name.title = stream.url;
  head.append(chip, name);

  const host = document.createElement('div');
  host.className = 'sc-host';
  host.textContent = stream.host || '';

  const actions = document.createElement('div');
  actions.className = 'sc-actions';
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary sc-dl';
  btn.textContent = 'Download';
  const barWrap = document.createElement('div');
  barWrap.className = 'sc-progress';
  barWrap.hidden = true;
  const bar = document.createElement('span');
  barWrap.appendChild(bar);
  const status = document.createElement('span');
  status.className = 'sc-status';
  status.hidden = true;
  actions.append(btn, barWrap, status);

  li.append(head, host, actions);

  const entry = { li, bar, barWrap, status, btn };
  cards.set(stream.id, entry);
  btn.addEventListener('click', () => startStreamDownload(stream, entry));
  return li;
}

// ---------------------------------------------------------------------------
// stream download
// ---------------------------------------------------------------------------
async function startStreamDownload(stream, entry) {
  const clientId = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
  clientToStream.set(clientId, stream.id);

  entry.btn.disabled = true;
  entry.btn.textContent = 'Downloading';
  entry.barWrap.hidden = false;
  entry.status.hidden = false;
  entry.status.className = 'sc-status';
  entry.status.textContent = 'Starting...';
  if (stream.kind === StreamKind.FILE) {
    entry.barWrap.classList.add('indeterminate');
  } else {
    entry.barWrap.classList.remove('indeterminate');
    entry.bar.style.width = '0%';
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.DOWNLOAD_STREAM,
      stream,
      title: seriesTitle || stream.name,
      clientId,
    });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Failed to start');
  } catch (e) {
    failCard(entry, e && e.message ? e.message : String(e));
  }
}

function failCard(entry, msg) {
  entry.barWrap.hidden = true;
  entry.barWrap.classList.remove('indeterminate');
  entry.status.hidden = false;
  entry.status.className = 'sc-status err';
  entry.status.textContent = msg || 'Failed';
  entry.btn.disabled = false;
  entry.btn.textContent = 'Retry';
}

function completeCard(entry, filename) {
  entry.barWrap.classList.remove('indeterminate');
  entry.bar.style.width = '100%';
  entry.status.hidden = false;
  entry.status.className = 'sc-status ok';
  entry.status.textContent = 'Saved' + (filename ? ' \u00b7 ' + filename : '');
  entry.btn.disabled = false;
  entry.btn.textContent = 'Download again';
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === MSG.STREAMS_UPDATED) {
    if (msg.tabId && currentTabId && msg.tabId !== currentTabId) return;
    streams = Array.isArray(msg.streams) ? msg.streams : streams;
    render();
    return;
  }
  if (msg.type === MSG.JOB_UPDATE) {
    const p = msg.payload || {};
    // per-stream (clientId) first
    const sid = p.meta && p.meta.clientId ? clientToStream.get(p.meta.clientId) : null;
    if (sid && cards.has(sid)) {
      const entry = cards.get(sid);
      entry.barWrap.hidden = false;
      entry.barWrap.classList.remove('indeterminate');
      const pct = p.progress && p.progress.total ? (p.progress.completed / p.progress.total * 100) : 0;
      entry.bar.style.width = pct.toFixed(1) + '%';
      entry.status.hidden = false;
      entry.status.className = 'sc-status';
      entry.status.textContent = p.state === 'finalizing' ? 'Assembling...'
        : `${p.progress.completed}/${p.progress.total} segments`;
      if (p.state === 'failed') failCard(entry, p.error || 'Download failed');
      return;
    }
    // manual range flow
    if (currentJobId && p.id === currentJobId) updateManualJob(p);
    return;
  }
  if (msg.type === MSG.DOWNLOAD_ALL_STATUS) {
    const p = msg.payload || {};
    if (p.clientId) {
      const sid = clientToStream.get(p.clientId);
      const entry = sid && cards.get(sid);
      if (entry) {
        if (p.state === 'done') completeCard(entry, p.filename);
        else if (p.state === 'failed') failCard(entry, p.error || 'Failed');
      }
      return;
    }
    // series bulk
    if (p.state === 'downloading') toast(`Episode ${p.episode} (${p.current}/${p.total})...`);
    else if (p.state === 'done') toast(p.failed && p.failed.length ? `Done. Failed: ${p.failed.join(', ')}` : 'All episodes saved.', 'ok');
    else if (p.state === 'failed') toast('Failed: ' + (p.error || 'unknown'), 'err');
  }
});

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------
$('downloadAllBtn').addEventListener('click', async () => {
  if (!episodesApiUrls.length) { toast('No episode list found.', 'err'); return; }
  try {
    const tabId = currentTabId || await getActiveTabId();
    if (tabId) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} }); },
      }).catch(() => {});
    }
    const res = await chrome.runtime.sendMessage({ type: MSG.DOWNLOAD_ALL_EPISODES, episodesApiUrls, title: seriesTitle || 'video' });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Failed');
    toast('Downloading all episodes in the background...');
  } catch (e) {
    toast('Error: ' + (e && e.message ? e.message : e), 'err');
  }
});

// ---------------------------------------------------------------------------
// advanced / manual flow
// ---------------------------------------------------------------------------
$('advToggle').addEventListener('click', () => {
  const panel = $('advPanel');
  const open = panel.hidden;
  panel.hidden = !open;
  $('advToggle').setAttribute('aria-expanded', String(open));
});

async function loadPlaylist(url) {
  if (!url) { toast('Enter a playlist URL.', 'err'); return false; }
  try {
    let pattern = '*://*/*';
    try { const u = new URL(url); pattern = `${u.protocol}//${u.host}/*`; } catch {}
    let granted = await chrome.permissions.contains({ origins: [pattern] });
    if (!granted) { try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch { granted = false; } }
    if (!granted) { toast('Host permission denied.', 'err'); return false; }
    const res = await chrome.runtime.sendMessage({ type: MSG.FETCH_PLAYLIST, url });
    if (!res || !res.ok) { toast(res && res.error ? res.error : 'Failed to load playlist.', 'err'); return false; }
    playlist = res.playlist;
    $('advMeta').hidden = false;
    const dur = playlist.totalDuration || 0;
    if (dur) {
      $('duration').textContent = formatTime(dur);
      $('endTime').value = dur.toFixed(1);
      const max = Math.max(1, Math.round(dur));
      $('rangeSlider').max = max; $('rangeSliderEnd').max = max;
      $('rangeSlider').value = 0; $('rangeSliderEnd').value = max;
    }
    if (!$('filenameInput').value.trim()) $('filenameInput').value = sanitize(playlist.title || 'video');
    updateSegCount();
    toast(`Loaded ${playlist.segments.length} segments (${playlist.isLive ? 'live' : 'VOD'}).`, 'ok');
    return true;
  } catch (e) {
    toast('Error: ' + (e && e.message ? e.message : e), 'err');
    return false;
  }
}

function readInterval() {
  const dur = (playlist && playlist.totalDuration) || 0;
  let start = parseFloat($('startTime').value) || 0;
  let end = parseFloat($('endTime').value) || 0;
  const c = clampInterval(start, end, dur);
  $('startTime').value = c.start.toFixed(1);
  $('endTime').value = c.end.toFixed(1);
  return c;
}

function updateSegCount() {
  if (!playlist) { $('segCount').textContent = '0'; return; }
  const { start, end } = readInterval();
  const count = estimateSegmentCount(playlist.segments, start, end);
  selectedSegments = segmentsInInterval(playlist.segments, start, end);
  $('segCount').textContent = `${count} / ${playlist.segments.length}`;
}

function updateManualJob(p) {
  const pct = p.progress && p.progress.total ? (p.progress.completed / p.progress.total * 100) : 0;
  const btn = $('downloadBtn');
  btn.textContent = p.state === 'finalizing' ? 'Assembling...' : `Downloading ${pct.toFixed(0)}%`;
  if (p.state === 'completed' && p.id === currentJobId) saveManualResult(p.id);
  if (p.state === 'failed') { toast('Failed: ' + (p.error || 'unknown'), 'err'); btn.disabled = false; btn.textContent = 'Download selected range'; }
}

async function saveManualResult(jobId) {
  const filename = (manualFilename || 'video');
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_JOB_RESULT, jobId });
    if (!res || !res.ok) { toast(res && res.error ? res.error : 'Failed to get result.', 'err'); return; }
    const binary = atob(res.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const isMp4 = /\.mp4$/i.test(filename) || (playlist && playlist.initSegmentUrl);
    const blob = new Blob([bytes.buffer], { type: isMp4 ? 'video/mp4' : 'video/mp2t' });
    const url = URL.createObjectURL(blob);
    const ext = isMp4 ? 'mp4' : 'ts';
    await chrome.downloads.download({ url, filename: filename.replace(/\.(ts|mp4)$/i, '') + '.' + ext, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Saved.', 'ok');
  } catch (e) {
    toast('Save failed: ' + (e && e.message ? e.message : e), 'err');
  } finally {
    $('downloadBtn').disabled = false;
    $('downloadBtn').textContent = 'Download selected range';
  }
}

$('loadPlaylistBtn').addEventListener('click', () => loadPlaylist($('playlistUrl').value.trim()));
$('fullBtn').addEventListener('click', () => {
  const dur = (playlist && playlist.totalDuration) || 0;
  $('startTime').value = 0; $('endTime').value = dur.toFixed(1);
  $('rangeSlider').value = 0; $('rangeSliderEnd').value = Math.round(dur);
  updateSegCount();
});
$('startTime').addEventListener('change', updateSegCount);
$('endTime').addEventListener('change', updateSegCount);
$('rangeSlider').addEventListener('input', () => { $('startTime').value = $('rangeSlider').value; updateSegCount(); });
$('rangeSliderEnd').addEventListener('input', () => { $('endTime').value = $('rangeSliderEnd').value; updateSegCount(); });

$('downloadBtn').addEventListener('click', async () => {
  if (!playlist) { const u = $('playlistUrl').value.trim(); if (u) await loadPlaylist(u); }
  updateSegCount();
  if (!selectedSegments.length) { toast('No segments in range. Load a playlist first.', 'err'); return; }
  manualFilename = sanitize($('filenameInput').value.trim() || playlist.title || 'video');
  const maxBytes = (parseFloat($('maxSize').value) || 1000) * 1024 * 1024;
  const btn = $('downloadBtn');
  btn.disabled = true; btn.textContent = 'Starting...';
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.START_DOWNLOAD,
      segments: selectedSegments,
      maxBytes,
      concurrency: 5,
      initSegmentUrl: playlist && playlist.initSegmentUrl,
    });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Failed to start');
    currentJobId = res.jobId;
  } catch (e) {
    toast('Error: ' + (e && e.message ? e.message : e), 'err');
    btn.disabled = false; btn.textContent = 'Download selected range';
  }
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function refresh() {
  currentTabId = await getActiveTabId();
  if (!currentTabId) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_STREAMS, tabId: currentTabId });
    if (res && res.ok && Array.isArray(res.streams)) { streams = res.streams; render(); }
  } catch {}
  // page detection for series + title (best-effort)
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.DETECT_VIDEO, tabId: currentTabId });
    const page = res && res.page;
    if (page) {
      episodesApiUrls = Array.isArray(page.episodesApiUrls) ? page.episodesApiUrls
        : (page.episodesApiUrl ? [page.episodesApiUrl] : []);
      const tab = await chrome.tabs.get(currentTabId).catch(() => null);
      seriesTitle = sanitize((tab && tab.title) || '');
      if (episodesApiUrls.length) {
        $('seriesBar').hidden = false;
        $('seriesCount').textContent = 'Bulk download every episode';
      }
    }
    if (res && res.ok && Array.isArray(res.streams) && res.streams.length) { streams = res.streams; render(); }
  } catch {}
}

$('refreshBtn').addEventListener('click', refresh);
refresh();
