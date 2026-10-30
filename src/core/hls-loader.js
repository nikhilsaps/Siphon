import { parseHlsPlaylist } from './hls-parser.js';

/**
 * Fetch a playlist (following master playlists to a media variant) and parse it.
 *
 * @param {Function} fetchImpl fetch-like function
 * @param {string} url playlist URL
 * @returns {Promise<object>} parsed playlist
 */
export async function loadHlsPlaylist(fetchImpl, url) {
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(url, { credentials: 'include', headers: { Accept: '*/*' } });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 0}`);
  const text = await res.text();
  const parsed = parseHlsPlaylist(text, url);
  if (parsed && Array.isArray(parsed.variants) && parsed.variants.length) {
    // Pick highest bandwidth variant.
    const variant = parsed.variants.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (variant && variant.url) return await loadHlsPlaylist(fetchFn, variant.url);
  }
  return parsed;
}

export default loadHlsPlaylist;
