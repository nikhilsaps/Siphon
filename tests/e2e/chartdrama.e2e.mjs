// End-to-end: load Siphon unpacked, open a real chartdrama drama, verify the
// detector catches the stream and the content script resolves the series.
// Runs headless on the box. Usage: node tests/e2e/chartdrama.e2e.mjs [dramaUrl]
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import fs from 'fs';

const EXT = path.resolve('.');                 // repo root = unpacked extension
const URL = process.argv[2] || 'https://chartdrama.com/d/5663/the-beggar-at-my-engagement-owns-the-company';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-e2e-'));
const OUT = 'tools/captures'; fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});

// Open the target first; its webRequest traffic wakes the MV3 service worker.
// Neutralize the site's anti-automation detectors (disable-devtool + anti-devtools.js)
await ctx.route(/anti-devtools\.js|disable-devtool/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* blocked by siphon e2e */' }));

const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => { const u = r.url(); if (/\.(m3u8|ts|mpd|m4s)(\?|#|$)/i.test(u)) reqs.push(u); });
console.log('NAV', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
if (!sw) { console.log('FAIL: no service worker (extension did not load)'); await ctx.close(); process.exit(1); }
const extId = sw.url().split('/')[2];
console.log('extension id:', extId);
await page.waitForTimeout(4000);
// force any video to play
await page.evaluate(() => document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play && v.play().catch(()=>{}); })).catch(()=>{});
// click likely play controls
for (const sel of ['video', '.play', '[class*="play"]', '.episode', '[class*="episode"]']) {
  const el = await page.$(sel); if (el) { await el.click({ timeout: 1500 }).catch(()=>{}); await page.waitForTimeout(800); }
}
await page.waitForTimeout(9000);

// 1) overlay state (pierce shadow DOM)
const overlay = await page.evaluate(() => {
  const host = document.querySelector('#siphon-root'); if (!host || !host.shadowRoot) return { present: false };
  const sr = host.shadowRoot;
  const cards = [...sr.querySelectorAll('.card .name')].map((n) => n.textContent.trim());
  const sub = sr.querySelector('.sub') ? sr.querySelector('.sub').textContent.trim() : '';
  const allBtn = !!sr.querySelector('.allbtn');
  return { present: true, cards, allBtn, sub };
}).catch((e) => ({ present: false, err: String(e) }));
console.log('\nOVERLAY:', JSON.stringify(overlay));

// 2) authoritative detector state via the extension's own messaging
const extPage = await ctx.newPage();
await extPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' }).catch(()=>{});
const detect = await extPage.evaluate(async (dramaUrl) => {
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && /chartdrama\.com\/[dp]\//.test(t.url));
    if (!tab) return { err: 'drama tab not found', tabs: tabs.map(t=>t.url) };
    const gs = await chrome.runtime.sendMessage({ type: 'GET_STREAMS', tabId: tab.id });
    const dv = await chrome.runtime.sendMessage({ type: 'DETECT_VIDEO', tabId: tab.id });
    return { tabId: tab.id, gs, dv };
  } catch (e) { return { err: String(e && e.stack || e) }; }
}, URL).catch((e) => ({ err: String(e) }));
console.log('\nMSG RESULT:', JSON.stringify(detect, null, 1));


await page.bringToFront();
await page.screenshot({ path: `${OUT}/overlay.png` }).catch(()=>{});
console.log('\nmanifest/segment requests seen by browser:', reqs.length, reqs.slice(0,3).join(' '));
console.log('screenshot -> tools/captures/overlay.png');

await ctx.close();
console.log('DONE');
