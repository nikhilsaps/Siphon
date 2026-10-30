import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHlsPlaylist } from '../src/core/hls-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, 'fixtures', 'sample-playlist.m3u8'), 'utf8');
const BASE = 'https://example.com/media/playlist.m3u8';

test('parses sample playlist: 46 segments', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  assert.equal(p.segments.length, 46);
});

test('total duration is 229.5', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  assert.equal(p.totalDuration, 229.5);
});

test('detects VOD (not live)', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  assert.equal(p.isLive, false);
});

test('target duration 5', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  assert.equal(p.targetDuration, 5);
});

test('media sequence 0', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  assert.equal(p.mediaSequence, 0);
});

test('first segment timing and url', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  const s = p.segments[0];
  assert.equal(s.duration, 5);
  assert.equal(s.start, 0);
  assert.equal(s.end, 5);
  assert.equal(s.url, 'https://example.com/media/video-00001.ts');
});

test('last segment timing', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  const s = p.segments[45];
  assert.equal(s.duration, 4.5);
  assert.equal(s.start, 225);
  assert.equal(s.end, 229.5);
  assert.equal(s.url, 'https://example.com/media/video-00046.ts');
});

test('cumulative start/end times monotonic', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  let cur = 0;
  for (const s of p.segments) {
    assert.equal(s.start, cur);
    cur += s.duration;
    assert.equal(s.end, cur);
  }
});

test('segment indices follow media sequence', () => {
  const p = parseHlsPlaylist(fixture, BASE);
  assert.equal(p.segments[0].index, 0);
  assert.equal(p.segments[45].index, 45);
});

test('live playlist (no ENDLIST) is live', () => {
  const live = fixture.replace('#EXT-X-ENDLIST', '');
  const p = parseHlsPlaylist(live, BASE);
  assert.equal(p.isLive, true);
  assert.equal(p.segments.length, 46);
});

test('handles missing/malformed entries safely', () => {
  const bad = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:abc,
video-x.ts
#EXTINF:5.000000,
video-y.ts
garbage line
#EXT-X-ENDLIST`;
  const p = parseHlsPlaylist(bad, BASE);
  // malformed EXTINF skipped; only valid segment parsed
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].url, 'https://example.com/media/video-y.ts');
});

test('empty playlist', () => {
  const p = parseHlsPlaylist('', BASE);
  assert.equal(p.segments.length, 0);
  assert.equal(p.totalDuration, 0);
});

test('playlist type VOD sets not live', () => {
  const vod = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000000,\nseg.ts\n#EXT-X-ENDLIST';
  const p = parseHlsPlaylist(vod, 'https://example.com/vod.m3u8');
  assert.equal(p.playlistType, 'VOD');
  assert.equal(p.isLive, false);
});

test('relative resolution against playlist url', () => {
  const pl = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.000000,\n../seg.ts\n#EXT-X-ENDLIST';
  const p = parseHlsPlaylist(pl, 'https://example.com/a/b/playlist.m3u8');
  assert.equal(p.segments[0].url, 'https://example.com/a/seg.ts');
});
