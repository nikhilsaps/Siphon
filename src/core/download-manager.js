// Download manager: job state machine, bounded concurrency, retries, cancellation.

export const JobState = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  DOWNLOADING: 'downloading',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

const TERMINAL = new Set([JobState.COMPLETED, JobState.CANCELLED, JobState.FAILED]);

export class DownloadJob {
  constructor({ id, segments, maxBytes = Infinity, concurrency = 3, retries = 3, initSegmentUrl = null, meta = null } = {}) {
    this.id = id || `job-${Date.now()}`;
    this.segments = Array.isArray(segments) ? segments.slice() : [];
    this.initSegmentUrl = initSegmentUrl;
    this.meta = meta;
    this.maxBytes = maxBytes;
    this.concurrency = Math.max(1, concurrency);
    this.retries = Math.max(0, retries);
    this.state = JobState.IDLE;
    this.progress = { completed: 0, total: this.segments.length, bytes: 0 };
    this.results = new Map(); // segment index -> ArrayBuffer
    this.error = null;
    this._cancelled = false;
    this._paused = false;
    this._abort = new AbortController();
  }

  isTerminal() {
    return TERMINAL.has(this.state);
  }

  cancel() {
    this._cancelled = true;
    this._abort.abort();
    if (!this.isTerminal()) this.state = JobState.CANCELLED;
  }

  pause() {
    if (this.isTerminal()) return;
    this._paused = true;
    this.state = JobState.PAUSED;
  }

  resume() {
    if (this.state === JobState.PAUSED) {
      this._paused = false;
      this.state = JobState.DOWNLOADING;
    }
  }
}

export class DownloadManager {
  constructor({ fetchImpl = (typeof fetch !== 'undefined' ? fetch : null), storage = null, onProgress = null } = {}) {
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.onProgress = onProgress;
    this.jobs = new Map();
    this.active = 0;
  }

  createJob(opts) {
    const job = new DownloadJob(opts);
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  async runJob(job) {
    if (!job) throw new Error('job required');
    if (job.isTerminal()) return job;
    job.state = JobState.PREPARING;
    this._emit(job);

    // Validate max size estimate (unknown sizes -> skip pre-check)
    let estimated = 0;
    // no size info; enforce during download

    job.state = JobState.DOWNLOADING;
    this._emit(job);

    const queue = job.segments.slice();
    const workers = [];
    const runOne = async (seg) => {
      if (job._cancelled) return;
      while (job._paused) {
        await new Promise((r) => setTimeout(r, 100));
        if (job._cancelled) return;
      }
      await this._downloadSegment(job, seg);
    };

    // bounded concurrency
    const executing = new Set();
    for (const seg of queue) {
      if (job._cancelled) break;
      while (executing.size >= job.concurrency) {
        await Promise.race(executing);
      }
      if (job._cancelled) break;
      while (job._paused) {
        await new Promise((r) => setTimeout(r, 100));
        if (job._cancelled) break;
      }
      if (job._cancelled) break;
      const p = runOne(seg).then(() => executing.delete(p));
      executing.add(p);
    }
    await Promise.all(executing);

    if (job._cancelled) {
      job.state = JobState.CANCELLED;
      this._cleanup(job);
      this._emit(job);
      return job;
    }
    if (job.error) {
      job.state = JobState.FAILED;
      this._emit(job);
      return job;
    }

    job.state = JobState.FINALIZING;
    this._emit(job);
    // Finalizing: optionally assemble. Left to caller / video-assembler.
    job.state = JobState.COMPLETED;
    this._emit(job);
    return job;
  }

  async _downloadSegment(job, seg) {
    if (job._cancelled) return;
    let attempt = 0;
    let lastErr = null;
    while (attempt <= job.retries) {
      if (job._cancelled) return;
      while (job._paused) {
        await new Promise((r) => setTimeout(r, 100));
        if (job._cancelled) return;
      }
      try {
        console.log('[Siphon][dm] fetching', seg.url);
        const fetchFn = this.fetchImpl;
        const res = await fetchFn.call(globalThis, seg.url, { signal: job._abort.signal, credentials: 'include', headers: { Accept: '*/*' } });
        console.log('[Siphon][dm] response', res && res.status, seg.url);
        if (!res || !res.ok) {
          const status = res ? res.status : 0;
          if (status === 401 || status === 403 || status === 404 || status === 410) {
            throw new Error(`HTTP ${status} for ${seg.url}`);
          }
          throw new Error(`HTTP ${status} for ${seg.url}`);
        }
        const buf = await res.arrayBuffer();
        // max size enforcement
        if (job.progress.bytes + buf.byteLength > job.maxBytes) {
          throw new Error('Maximum download size exceeded');
        }
        job.results.set(seg.index ?? seg.url, buf);
        job.progress.completed += 1;
        job.progress.bytes += buf.byteLength;
        this._emit(job);
        return;
      } catch (err) {
        console.warn('[Siphon][dm] error', seg.url, err && err.message ? err.message : err);
        lastErr = err;
        if (job._cancelled) return;
        // expired URL / auth errors: don't retry
        const msg = String(err && err.message ? err.message : err);
        if (/HTTP (401|403|404|410)/.test(msg) || /Maximum download size/.test(msg)) {
          break;
        }
        attempt += 1;
        if (attempt <= job.retries) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    job.error = lastErr ? lastErr.message : 'download failed';
  }

  _cleanup(job) {
    job.results.clear();
  }

  _emit(job) {
    if (typeof this.onProgress === 'function') {
      this.onProgress({
        id: job.id,
        meta: job.meta,
        state: job.state,
        progress: { ...job.progress },
        error: job.error,
      });
    }
  }

  cancelJob(id) {
    const job = this.jobs.get(id);
    if (job) job.cancel();
  }

  pauseJob(id) {
    const job = this.jobs.get(id);
    if (job) job.pause();
  }

  resumeJob(id) {
    const job = this.jobs.get(id);
    if (job) job.resume();
  }
}

export default DownloadManager;
