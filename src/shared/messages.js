// Internal message types used between popup, content script and service worker.
export const MSG = {
  // detection
  DETECT_VIDEO: 'DETECT_VIDEO',
  GET_STREAMS: 'GET_STREAMS',
  STREAMS_UPDATED: 'STREAMS_UPDATED',
  CLEAR_STREAMS: 'CLEAR_STREAMS',
  // playlist / episodes
  FETCH_PLAYLIST: 'FETCH_PLAYLIST',
  FETCH_EPISODES: 'FETCH_EPISODES',
  // downloads
  DOWNLOAD_STREAM: 'DOWNLOAD_STREAM',
  START_DOWNLOAD: 'START_DOWNLOAD',
  DOWNLOAD_ALL_EPISODES: 'DOWNLOAD_ALL_EPISODES',
  DOWNLOAD_ALL_STATUS: 'DOWNLOAD_ALL_STATUS',
  // job control
  JOB_UPDATE: 'JOB_UPDATE',
  JOB_CANCEL: 'JOB_CANCEL',
  JOB_PAUSE: 'JOB_PAUSE',
  JOB_RESUME: 'JOB_RESUME',
  GET_JOB_RESULT: 'GET_JOB_RESULT',
  GET_JOBS: 'GET_JOBS',
  // misc
  OPEN_POPUP: 'OPEN_POPUP',
  ERROR: 'ERROR',
};

// Stream kinds the detector recognizes.
export const StreamKind = {
  HLS: 'hls',
  DASH: 'dash',
  FILE: 'file',   // direct mp4/webm/mkv/etc.
  UNKNOWN: 'unknown',
};

export default MSG;
