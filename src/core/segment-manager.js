// Model segment ordering and selected time interval for an HLS playlist.

/**
 * Given parsed playlist segments and a time interval [start, end] (seconds),
 * return the segments that overlap the interval.
 */
export function segmentsInInterval(segments, start, end) {
  if (!Array.isArray(segments)) return [];
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end) ? end : Infinity;
  const lo = Math.min(s, e);
  const hi = Math.max(s, e);
  return segments.filter((seg) => {
    // overlap: seg.start < hi && seg.end > lo
    return seg.start < hi && seg.end > lo;
  });
}

export function totalDuration(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  return segments[segments.length - 1].end;
}

export function estimateSegmentCount(segments, start, end) {
  return segmentsInInterval(segments, start, end).length;
}

export function clampInterval(start, end, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  let s = Number.isFinite(start) ? start : 0;
  let e = Number.isFinite(end) ? end : d;
  s = Math.max(0, Math.min(s, d));
  e = Math.max(0, Math.min(e, d));
  if (s > e) {
    const t = s; s = e; e = t;
  }
  return { start: s, end: e };
}

export default { segmentsInInterval, totalDuration, estimateSegmentCount, clampInterval };
