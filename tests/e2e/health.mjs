// Resolver health-check for Siphon's two reverse-engineered resolvers
// (chartdrama episode re-signing + dramatip HLS). These
// break SILENTLY when the sites change their markup/APIs, so this script loads
// the real unpacked extension, hits a known-good URL per resolver, and asserts
// that media was actually resolved.
//
// Usage (run on the box, where network + Playwright live):
//   node tests/e2e/health.mjs
//
// Exit codes (so a scheduler can act on them):
//   0  all resolvers healthy
//   2  a resolver is BROKEN  — site reachable but no media resolved (needs a code fix)
//   3  a target site was UNREACHABLE — network/site down, NOT a resolver bug (retry later)
//   1  harness failure — extension did not load (environment problem)
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const EXT = path.resolve('.');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHARTDRAMA = 'https://dramabox.chartdrama.com/p/42000027028/abandoned-husband-titan-lord?ep=1';
const DRAMATIP = 'https://dramatip.net/series/chained-together';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-health-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
  userAgent: UA,
});

// wake the MV3 service worker
let [sw] = ctx.serviceWorkers();
if (!sw) {
  const warm = await ctx.newPage();
  await warm.goto('about:blank').catch(() => {});
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  await warm.close().catch(() => {});
}
if (!sw) {
  console.log('HARNESS FAIL: service worker never started (extension did not load)');
  await ctx.close();
  process.exit(1);
}
const extId = sw.url().split('/')[2];
console.log('extension id:', extId, '\n');

// chartdrama ships disable-devtool, which detects headless automation and
// redirects the page to about:blank. Neutralise it so the real page loads.
await ctx.route(/anti-devtool|disable-devtool/i, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '/* neutralised for health-check */' }));

const results = [];

// ── chartdrama ─────────────────────────────────────────────────────────────
// Healthy = the series resolver finds episode APIs AND the refresh-episode
// endpoint still re-signs a playable URL (this is the exact call the bulk
// downloader relies on; a 403 / shape change here is the silent failure mode).
async function checkChartdrama() {
  const name = 'chartdrama';
  const page = await ctx.newPage();
  try {
    await page.goto(CHARTDRAMA, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    await page.close().catch(() => {});
    return { name, status: 'UNREACHABLE', detail: `navigation failed: ${String(e.message || e)}` };
  }
  await page.waitForTimeout(2500);
  console.log('  chartdrama page.url() after nav:', page.url());
  for (const sel of ['video', '[class*="play"]', '[class*="episode"]']) {
    const el = await page.$(sel); if (el) { await el.click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(600); }
  }
  await page.waitForTimeout(6000);

  // Ask the extension (via the popup page) which episode APIs it detected.
  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const apisInfo = await extPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    let tab = tabs.find((t) => t.url && t.url.includes('chartdrama.com'));
    if (!tab) tab = tabs.find((t) => t.url && !t.url.startsWith('about:') && !t.url.startsWith('chrome-extension://'));
    if (!tab) return { err: 'drama tab not found; tabs=' + JSON.stringify(tabs.map((t) => t.url)) };
    const detect = await chrome.runtime.sendMessage({ type: 'DETECT_VIDEO', tabId: tab.id });
    return { apis: (detect && detect.page && detect.page.episodesApiUrls) || [] };
  }).catch((e) => ({ err: String(e) }));
  await extPage.close().catch(() => {});
  await page.close().catch(() => {});

  if (apisInfo.err) return { name, status: 'BROKEN', detail: apisInfo.err };
  const apis = apisInfo.apis;
  if (!apis.length) return { name, status: 'BROKEN', detail: 'series resolver found 0 episode APIs (page markup likely changed)' };

  // Reproduce the exact URL the bulk downloader would use for episode 1, then
  // confirm it serves real media. chartdrama now proxies episodes through a CF
  // worker that returns playable MP4/HLS directly; the legacy refresh-episode
  // endpoint is best-effort (freshEpisode() falls back to the listed URL when it
  // errors), so the meaningful health signal is "does the resolved URL play?",
  // not "does refresh return 200?". Run it in the service worker to match the
  // downloader's request context (no document Origin header).
  const probe = await sw.evaluate(async (apiUrls) => {
    // mirror chartdramaRefreshBase()
    let refreshBase = null;
    for (const u of apiUrls) { try { const x = new URL(u); const m = x.pathname.match(/^\/api\/drama\/(\d+)\/episodes\/?$/); if (m && /chartdrama\.com$/i.test(x.hostname)) { refreshBase = `${x.origin}/api/drama/${m[1]}/refresh-episode`; break; } } catch {} }
    // get episode list
    let items = [];
    for (const u of apiUrls) { try { const r = await fetch(u); if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.items) && j.items.length) { items = j.items; break; } } } catch {} }
    if (!items.length) return { ok: false, detail: 'episodes API returned no items' };
    const first = items[0];
    // mirror freshEpisode(): try refresh, fall back to listed url
    let url = first.url || '', via = 'listed-url', subtitleUrl = '';
    if (refreshBase && first.ep != null) {
      try { const r = await fetch(`${refreshBase}?ep=${encodeURIComponent(first.ep)}`); if (r.ok) { const j = await r.json(); if (j && j.url) { url = j.url; via = 'refresh-episode'; subtitleUrl = j.subtitleUrl || ''; } } } catch {}
    }
    if (!url) return { ok: false, detail: 'resolved episode URL is empty' };
    // confirm the resolved URL actually serves media
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-15' } });
      if (!(r.status === 200 || r.status === 206)) return { ok: false, detail: `resolved url (${via}) served HTTP ${r.status}` };
      const buf = new Uint8Array(await r.arrayBuffer());
      const head = Array.from(buf.slice(0, 12)).map((b) => String.fromCharCode(b)).join('');
      const isMp4 = head.includes('ftyp');
      const isHls = head.includes('#EXTM3U');
      if (!isMp4 && !isHls && buf.length < 4) return { ok: false, detail: `resolved url (${via}) served ${r.status} but no media bytes` };
      return { ok: true, detail: `${items.length} eps; ep${first.ep} via ${via} serves ${r.status} ${isMp4 ? 'MP4' : isHls ? 'HLS' : 'media'}; subs ${subtitleUrl ? 'yes' : 'none'}` };
    } catch (e) { return { ok: false, detail: `fetch of resolved url (${via}) threw: ${String(e)}` }; }
  }, apis).catch((e) => ({ ok: false, detail: `sw.evaluate failed: ${String(e)}` }));

  if (!probe.ok) return { name, status: 'BROKEN', detail: probe.detail };
  return { name, status: 'PASS', detail: probe.detail };
}

// ── dramatip ───────────────────────────────────────────────────
// dramatip plays HLS via blob: MSE; the passive detector still catches the
// .m3u8, but its CDN (cdn.dramadizilerim.xyz) 451s any request lacking the site
// Referer. Healthy = the stream is detected AND a Referer-injected fetch (the
// same declarativeNetRequest rewrite the downloader installs) returns the real
// manifest, not "origin not allowed".
async function checkDramatip() {
  const name = 'dramatip';
  const page = await ctx.newPage();
  try {
    await page.goto(DRAMATIP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    await page.close().catch(() => {});
    return { name, status: 'UNREACHABLE', detail: `navigation failed: ${String(e.message || e)}` };
  }
  await page.waitForTimeout(3000);
  for (const sel of ['video', '[class*="play"]', 'button']) { const el = await page.$(sel); if (el) { await el.click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(900); } }
  await page.waitForTimeout(6000);

  const extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const got = await extPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.includes('dramatip.net'));
    if (!tab) return { err: 'dramatip tab not found' };
    const r = await chrome.runtime.sendMessage({ type: 'GET_STREAMS', tabId: tab.id });
    const hls = (r && r.streams || []).find((x) => x.kind === 'hls');
    return { url: hls && hls.url, pageOrigin: hls && hls.pageOrigin };
  }).catch((e) => ({ err: String(e) }));
  await extPage.close().catch(() => {});
  await page.close().catch(() => {});

  if (got.err) return { name, status: 'BROKEN', detail: got.err };
  if (!got.url) return { name, status: 'BROKEN', detail: 'no HLS stream detected (player markup/CDN likely changed)' };
  if (!got.pageOrigin) return { name, status: 'BROKEN', detail: 'stream detected but pageOrigin not captured (detector regression)' };

  // Install the same Referer rewrite the downloader uses, then fetch the manifest
  // from the service-worker context.
  const probe = await sw.evaluate(async ({ url, pageOrigin }) => {
    const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
    const id = 7001;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id], addRules: [{ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: pageOrigin + '/' }, { header: 'origin', operation: 'set', value: pageOrigin }] }, condition: { requestDomains: [hostOf(url)], resourceTypes: ['xmlhttprequest', 'media', 'other'] } }] });
    } catch (e) { return { ok: false, detail: 'DNR rule failed: ' + String(e) }; }
    let out;
    try {
      const r = await fetch(url);
      const txt = await r.text();
      out = { ok: r.status === 200 && txt.includes('#EXTM3U'), detail: `manifest HTTP ${r.status}, ${txt.includes('#EXTM3U') ? 'valid m3u8' : 'body=' + txt.slice(0, 40)}` };
    } catch (e) { out = { ok: false, detail: 'manifest fetch threw: ' + String(e) }; }
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch {}
    return out;
  }, got).catch((e) => ({ ok: false, detail: `sw.evaluate failed: ${String(e)}` }));

  if (!probe.ok) return { name, status: 'BROKEN', detail: probe.detail };
  return { name, status: 'PASS', detail: `HLS detected + Referer-fetch ok (${probe.detail})` };
}

results.push(await checkChartdrama());
results.push(await checkDramatip());
await ctx.close();

// ── report ──────────────────────────────────────────────────────────────────
console.log('\n── Siphon resolver health ──────────────────────────────');
for (const r of results) console.log(`  [${r.status.padEnd(11)}] ${r.name.padEnd(11)} ${r.detail}`);
console.log('─────────────────────────────────────────────────────────');

const anyBroken = results.some((r) => r.status === 'BROKEN');
const anyUnreachable = results.some((r) => r.status === 'UNREACHABLE');
if (anyBroken) { console.log('RESULT: BROKEN — at least one resolver needs a code fix.'); process.exit(2); }
if (anyUnreachable) { console.log('RESULT: INCONCLUSIVE — a site was unreachable; retry later.'); process.exit(3); }
console.log('RESULT: HEALTHY — all resolvers working.');
process.exit(0);
