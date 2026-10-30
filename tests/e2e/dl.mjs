// Real download test: mimic the extension background path from the box.
// episodes API -> ep1 direct m3u8 -> parse .ts -> fetch all -> ffmpeg concat -> ffprobe verify.
import { chromium } from 'playwright';
import path from 'path'; import os from 'os'; import fs from 'fs';
import { spawnSync } from 'child_process';
const DRAMA = process.argv[2] || '5663/the-beggar-at-my-engagement-owns-the-company';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's-'));
const ctx = await chromium.launchPersistentContext(dir, { headless:false, args:['--headless=new'] });
await ctx.route(/anti-devtools\.js|disable-devtool/, (r)=>r.fulfill({status:200,contentType:'application/javascript',body:'/* */'}));
const page = ctx.pages()[0]||await ctx.newPage();
await page.goto('https://chartdrama.com/d/'+DRAMA,{waitUntil:'load',timeout:60000});
await page.waitForTimeout(3000);
// resolve episodes exactly like the extension content script
const eps = await page.evaluate(async (d) => {
  const [id,slug] = d.split('/');
  const w = await fetch(`${location.origin}/api/watch/${encodeURIComponent(id+'/'+slug)}`).then(r=>r.json());
  const e = await fetch(`${location.origin}/api/drama/${w.dramaId}/episodes`).then(r=>r.json());
  return { dramaId:w.dramaId, title:w.title, items:e.items };
}, DRAMA);
console.log('series:', eps.title, '| dramaId', eps.dramaId, '| episodes', eps.items.length);
const ep1 = eps.items[0];
console.log('ep1 url:', ep1.url);
// fetch m3u8 + segments IN PAGE CONTEXT (proves CORS * from a web origin like the extension bg)
const m3u8 = await page.evaluate((u)=>fetch(u).then(r=>r.ok?r.text():('HTTP '+r.status)), ep1.url);
const base = ep1.url.slice(0, ep1.url.lastIndexOf('/')+1);
const segs = m3u8.split('\n').filter(l=>l.trim() && !l.startsWith('#')).map(s=> s.startsWith('http')?s:base+s.trim());
console.log('m3u8 lines ok | segments:', segs.length, '| first:', segs[0]);
const outDir = path.join('tools','captures','ep1'); fs.mkdirSync(outDir,{recursive:true});
let total=0; const files=[];
for (let i=0;i<segs.length;i++){
  const buf = await page.evaluate(async (u)=>{ const r=await fetch(u); const b=await r.arrayBuffer(); return Array.from(new Uint8Array(b)); }, segs[i]);
  const fn = path.join(outDir, String(i).padStart(4,'0')+'.ts');
  fs.writeFileSync(fn, Buffer.from(buf)); total+=buf.length; files.push(fn);
}
console.log('downloaded', files.length, 'segments,', (total/1048576).toFixed(1), 'MB');
await ctx.close();
// concat + remux to mp4 via ffmpeg
const listFile = path.join(outDir,'list.txt');
fs.writeFileSync(listFile, files.map(f=>`file '${path.resolve(f).replace(/\\/g,'/')}'`).join('\n'));
const mp4 = path.join('tools','captures','ep1.mp4');
const ff = spawnSync('node_modules/.bin/ffmpeg'+(process.platform==='win32'?'.cmd':''), ['-y','-f','concat','-safe','0','-i',listFile,'-c','copy',mp4], {encoding:'utf8'});
let ffbin = 'ffmpeg';
console.log('ffmpeg exit', ff.status, (ff.stderr||'').split('\n').slice(-3).join(' | '));
if (ff.status!==0){
  // fallback: raw concat of ts into one file
  const raw = path.join('tools','captures','ep1.ts');
  fs.writeFileSync(raw, Buffer.concat(files.map(f=>fs.readFileSync(f))));
  console.log('fallback raw ts:', raw, fs.statSync(raw).size, 'bytes');
} else {
  const st = fs.statSync(mp4);
  console.log('MP4 OK:', mp4, (st.size/1048576).toFixed(1),'MB');
}
