import { parseDuration, resolveUrl } from '../shared/utils.js';

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : m[3];
    attrs[key] = val;
  }
  return attrs;
}

export function parseHlsPlaylist(text, playlistUrl) {
  const result = {
    version: null,
    targetDuration: null,
    mediaSequence: 0,
    playlistType: null,
    isLive: true,
    totalDuration: 0,
    segments: [],
    variants: [],
    isMaster: false,
    master: false,
    initSegmentUrl: null,
    initSegment: null,
    initUrl: null,
    init: null,
    initSegmentByteRange: null,
  };

  if (typeof text !== 'string' || text.trim() === '') {
    return result;
  }

  const lines = text.split(/\r?\n/);
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) {
    lines[0] = lines[0].slice(1);
  }

  let pendingDuration = null;
  let pendingTitle = null;
  let segmentIndex = 0;
  let cumulative = 0;
  const base = playlistUrl || '';
  let pendingStreamInf = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-VERSION:')) {
        const v = Number(line.slice('#EXT-X-VERSION:'.length));
        if (Number.isFinite(v)) result.version = v;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        const v = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
        if (Number.isFinite(v) && v >= 0) result.targetDuration = v;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const v = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
        if (Number.isFinite(v) && v >= 0) result.mediaSequence = v;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        result.playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim() || null;
        if (result.playlistType === 'VOD') result.isLive = false;
        if (result.playlistType === 'EVENT') result.isLive = true;
      } else if (line === '#EXT-X-ENDLIST') {
        result.isLive = false;
      } else if (line.startsWith('#EXTINF:')) {
        const rest = line.slice('#EXTINF:'.length);
        const commaIdx = rest.indexOf(',');
        let durStr = rest;
        let title = null;
        if (commaIdx >= 0) {
          durStr = rest.slice(0, commaIdx);
          title = rest.slice(commaIdx + 1).trim();
        }
        const dur = Number(durStr.trim());
        if (Number.isFinite(dur) && dur >= 0) {
          pendingDuration = dur;
          pendingTitle = title;
        } else {
          pendingDuration = null;
          pendingTitle = null;
        }
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pendingStreamInf = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) {
          const u = resolveUrl(base, String(attrs.URI).replace(/^"|"$/g, ''));
          result.initSegmentUrl = u;
        }
        if (attrs.BYTERANGE) result.initSegmentByteRange = attrs.BYTERANGE;
      }
      continue;
    }

    if (pendingStreamInf) {
      result.variants.push({
        url: resolveUrl(base, line),
        bandwidth: pendingStreamInf.BANDWIDTH ? Number(pendingStreamInf.BANDWIDTH) : null,
        averageBandwidth: pendingStreamInf['AVERAGE-BANDWIDTH'] ? Number(pendingStreamInf['AVERAGE-BANDWIDTH']) : null,
        resolution: pendingStreamInf.RESOLUTION || null,
        codecs: pendingStreamInf.CODECS || null,
        frameRate: pendingStreamInf['FRAME-RATE'] ? Number(pendingStreamInf['FRAME-RATE']) : null,
        audio: pendingStreamInf.AUDIO || null,
      });
      pendingStreamInf = null;
      continue;
    }

    if (pendingDuration === null) {
      continue;
    }

    const url = resolveUrl(base, line);
    const duration = pendingDuration;
    const start = cumulative;
    const end = cumulative + duration;
    result.segments.push({
      index: result.mediaSequence + segmentIndex,
      url,
      duration,
      start,
      end,
      title: pendingTitle,
    });
    cumulative = end;
    segmentIndex++;
    pendingDuration = null;
    pendingTitle = null;
  }

  result.totalDuration = cumulative;
  result.isMaster = result.variants.length > 0;
  result.master = result.isMaster;

  if (result.initSegmentUrl) {
    result.initSegment = result.initSegmentUrl;
    result.initUrl = result.initSegmentUrl;
    result.init = result.initSegmentUrl;
  }

  return result;
}

export default parseHlsPlaylist;
