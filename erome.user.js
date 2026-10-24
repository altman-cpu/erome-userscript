// ==UserScript==
// @name         erome.com video length
// @namespace    https://github.com/drdre1/
// @icon         https://www.erome.com/favicon.ico
// @version      2.1.0
// @description  Duration of video on erome.com, with duration filtering and a videos-only album mode
// @author       drdre1
// @match        https://www.erome.com/*
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Pure helpers (also exported for the test-suite; no DOM access here)
   * ------------------------------------------------------------------ */

  const EBML_ID = {
    SEGMENT: 0x18538067,
    INFO: 0x1549a966,
    TIMECODE_SCALE: 0x2ad7b1,
    DURATION: 0x4489,
  };

  const MAX_HEAD_BYTES = 262143;
  const MAX_HEAD_RETRY_BYTES = 2 * 1024 * 1024;
  const MAX_TAIL_BYTES = 524288;
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const HIDDEN_CLASS = 'erome-vl-hidden';

  /**
   * Formats a duration in milliseconds as `m:ss` or `h:mm:ss`.
   * Returns an empty string for anything that is not a finite, non-negative number.
   */
  function formatDuration(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
      return '';
    }
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const paddedSeconds = String(seconds).padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
    }
    return `${minutes}:${paddedSeconds}`;
  }

  /**
   * Reads an EBML variable-length integer (VINT).
   * Returns the numeric value, the encoded width and whether every value bit is set
   * (which, for sizes, means "unknown length").
   */
  function readVint(bytes, position) {
    if (!bytes || position < 0 || position >= bytes.length) {
      return null;
    }
    const first = bytes[position];
    if (first === 0) {
      return null;
    }
    let width = 1;
    let mask = 0x80;
    while (width <= 8 && (first & mask) === 0) {
      mask >>= 1;
      width += 1;
    }
    if (width > 8 || position + width > bytes.length) {
      return null;
    }
    let value = first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < width; i += 1) {
      const byte = bytes[position + i];
      value = value * 256 + byte;
      if (byte !== 0xff) {
        allOnes = false;
      }
    }
    return { value, width, unknown: allOnes };
  }

  /** Reads an EBML element id (kept byte-for-byte, marker bits included). */
  function readElementId(bytes, position) {
    const vint = readVint(bytes, position);
    if (!vint) {
      return null;
    }
    let id = 0;
    for (let i = 0; i < vint.width; i += 1) {
      id = id * 256 + bytes[position + i];
    }
    return { id, width: vint.width };
  }

  function readFloat(bytes, offset, length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
    if (length === 4) {
      return view.getFloat32(0);
    }
    if (length === 8) {
      return view.getFloat64(0);
    }
    return null;
  }

  function readUint(bytes, offset, length) {
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value = value * 256 + bytes[offset + i];
    }
    return value;
  }

  /**
   * Walks EBML (WebM / Matroska) looking for Segment > Info > Duration.
   * Clusters are never entered, so a truncated header costs one short scan.
   */
  function parseEbmlDuration(bytes, depth = 0, start = 0, end = bytes ? bytes.length : 0) {
    if (!bytes || bytes.length < 4 || depth > 6) {
      return null;
    }
    let position = start;
    let timecodeScale = 1000000; // Matroska default: one tick = 1 ms
    let ticks = null;

    while (position < end) {
      const id = readElementId(bytes, position);
      if (!id) {
        break;
      }
      const size = readVint(bytes, position + id.width);
      if (!size) {
        break;
      }
      const dataStart = position + id.width + size.width;
      if (dataStart > end) {
        break;
      }
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);

      if (id.id === EBML_ID.SEGMENT || id.id === EBML_ID.INFO) {
        const nested = parseEbmlDuration(bytes, depth + 1, dataStart, dataEnd);
        if (nested !== null) {
          return nested;
        }
      } else if (id.id === EBML_ID.TIMECODE_SCALE && size.value > 0 && size.value <= 8) {
        const scale = readUint(bytes, dataStart, size.value);
        if (scale > 0) {
          timecodeScale = scale;
        }
      } else if (id.id === EBML_ID.DURATION && (size.value === 4 || size.value === 8)) {
        const value = readFloat(bytes, dataStart, size.value);
        if (Number.isFinite(value) && value >= 0) {
          ticks = value;
        }
      }

      if (size.unknown) {
        break;
      }
      position = dataEnd;
    }

    if (ticks === null) {
      return null;
    }
    // Duration is measured in timecode ticks; one tick is `timecodeScale` nanoseconds.
    return (ticks * timecodeScale) / 1000000;
  }

  function readMvhdDuration(bytes, payloadStart, payloadEnd) {
    if (payloadStart + 4 > payloadEnd) {
      return null;
    }
    const version = bytes[payloadStart];
    let cursor = payloadStart + 4; // skip version + flags
    let timescale;
    let duration;
    if (version === 1) {
      if (cursor + 28 > payloadEnd) {
        return null;
      }
      cursor += 16; // creation + modification, 64 bit each
      timescale = readUint(bytes, cursor, 4);
      cursor += 4;
      const high = readUint(bytes, cursor, 4);
      const low = readUint(bytes, cursor + 4, 4);
      duration = high * 4294967296 + low;
    } else {
      if (cursor + 16 > payloadEnd) {
        return null;
      }
      cursor += 8; // creation + modification, 32 bit each
      timescale = readUint(bytes, cursor, 4);
      cursor += 4;
      duration = readUint(bytes, cursor, 4);
    }
    if (!timescale || !Number.isFinite(duration)) {
      return null;
    }
    return (duration / timescale) * 1000;
  }

  const MVHD_MARKER = [0x6d, 0x76, 0x68, 0x64]; // 'mvhd'

  /**
   * Last-resort scan for an `mvhd` box. A tail Range request starts in the
   * middle of the file, so box walking cannot begin at offset 0; searching for
   * the signature is safe because the payload layout does not depend on parent.
   */
  function scanForMvhd(bytes) {
    for (let i = 4; i + 8 <= bytes.length; i += 1) {
      if (
        bytes[i] !== MVHD_MARKER[0]
        || bytes[i + 1] !== MVHD_MARKER[1]
        || bytes[i + 2] !== MVHD_MARKER[2]
        || bytes[i + 3] !== MVHD_MARKER[3]
      ) {
        continue;
      }
      const boxStart = i - 4;
      let payloadEnd = bytes.length;
      const size = readUint(bytes, boxStart, 4);
      if (size >= 8 && boxStart + size <= bytes.length) {
        payloadEnd = boxStart + size;
      }
      const duration = readMvhdDuration(bytes, i + 4, payloadEnd);
      if (duration !== null && duration > 0) {
        return duration;
      }
    }
    return null;
  }

  /** Walks ISO-BMFF (MP4 / M4V) looking for moov > mvhd. */
  function parseMp4Duration(bytes) {
    if (!bytes || bytes.length < 16) {
      return null;
    }
    const duration = walkMp4Duration(bytes);
    return duration !== null ? duration : scanForMvhd(bytes);
  }

  function walkMp4Duration(bytes) {
    let position = 0;
    while (position + 8 <= bytes.length) {
      let size = readUint(bytes, position, 4);
      const type = String.fromCharCode(
        bytes[position + 4],
        bytes[position + 5],
        bytes[position + 6],
        bytes[position + 7],
      );
      let headerSize = 8;
      if (size === 1) {
        if (position + 16 > bytes.length) {
          return null;
        }
        size = readUint(bytes, position + 8, 4) * 4294967296 + readUint(bytes, position + 12, 4);
        headerSize = 16;
      } else if (size === 0) {
        size = bytes.length - position;
      }
      if (size < headerSize) {
        return null;
      }

      const boxEnd = position + size;
      if (type === 'moov') {
        const limit = Math.min(bytes.length, boxEnd);
        for (let inner = position + headerSize; inner + 8 <= limit; ) {
          const innerSize = readUint(bytes, inner, 4);
          const innerType = String.fromCharCode(
            bytes[inner + 4],
            bytes[inner + 5],
            bytes[inner + 6],
            bytes[inner + 7],
          );
          if (innerType === 'mvhd') {
            return readMvhdDuration(bytes, inner + 8, Math.min(limit, inner + innerSize));
          }
          if (innerSize < 8) {
            break;
          }
          inner += innerSize;
        }
        return null;
      }

      if (boxEnd > bytes.length) {
        return null; // truncated box, child offsets would be meaningless
      }
      position = boxEnd;
    }
    return null;
  }

  /** Detects the container from its signature. */
  function sniffContainer(bytes) {
    if (!bytes || bytes.length < 8) {
      return null;
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return 'webm';
    }
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      return 'mp4';
    }
    return null;
  }

  /** Container-agnostic entry point: bytes in, milliseconds out (or null). */
  function parseDurationBytes(bytes) {
    if (!bytes || bytes.length < 8) {
      return null;
    }
    const container = sniffContainer(bytes);
    let duration = null;
    if (container === 'webm') {
      duration = parseEbmlDuration(bytes);
    } else if (container === 'mp4') {
      duration = parseMp4Duration(bytes);
    } else {
      duration = parseEbmlDuration(bytes);
      if (duration === null) {
        duration = parseMp4Duration(bytes);
      }
    }
    return duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  /** `#onlyvideos=3` -> `{ onlyVideos: 3 }`; tolerant of absent or extra fragments. */
  function parseHash(hash) {
    const match = /(?:^#|&)onlyvideos=(\d+)/.exec(hash || '');
    if (!match) {
      return { onlyVideos: null };
    }
    const value = parseInt(match[1], 10);
    return { onlyVideos: Number.isFinite(value) && value > 0 ? value : null };
  }

  function buildHash(count) {
    return count > 0 ? `#onlyvideos=${count}` : '';
  }

  function probeError(message, retryable) {
    const error = new Error(message);
    error.retryable = Boolean(retryable);
    return error;
  }

  /**
   * Grows the delay between sweeps while nothing new appears and snaps back to
   * the base as soon as a sweep finds something, so a page that never changes
   * costs almost nothing.
   */
  function nextSweepDelay(previousDelay, foundNew, base = 4000, max = 60000) {
    if (foundNew) {
      return base;
    }
    if (!Number.isFinite(previousDelay) || previousDelay <= 0) {
      return base;
    }
    return Math.min(max, Math.max(base, previousDelay * 2));
  }

  /**
   * Runs probe tasks with a fixed number of slots in flight, retrying transient
   * failures with capped exponential backoff. Non-retryable errors fail at once.
   */
  function createTaskQueue(options = {}) {
    const concurrency = Math.max(1, options.concurrency || 3);
    const maxAttempts = Math.max(1, options.maxAttempts || 3);
    const baseDelay = options.baseDelay === undefined ? 750 : options.baseDelay;
    const maxDelay = options.maxDelay === undefined ? 8000 : options.maxDelay;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const random = options.random || Math.random;

    const waiting = [];
    const activeKeys = new Set();
    const counts = { loaded: 0, failed: 0, running: 0 };
    let stopped = false;

    function backoff(attempt) {
      const raw = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
      return Math.round(raw * (0.5 + random() * 0.5));
    }

    function pump() {
      while (!stopped && counts.running < concurrency && waiting.length > 0) {
        counts.running += 1;
        execute(waiting.shift());
      }
    }

    async function execute(task) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const value = await task.run();
          counts.running -= 1;
          counts.loaded += 1;
          if (task.key) {
            activeKeys.delete(task.key);
          }
          if (typeof task.onSuccess === 'function') {
            task.onSuccess(value);
          }
          pump();
          return;
        } catch (error) {
          const fatal = error && error.retryable === false;
          if (fatal || attempt >= maxAttempts || stopped) {
            counts.running -= 1;
            counts.failed += 1;
            if (task.key) {
              activeKeys.delete(task.key);
            }
            if (typeof task.onFailure === 'function') {
              task.onFailure(error, attempt);
            }
            pump();
            return;
          }
          await sleep(backoff(attempt));
        }
      }
    }

    return {
      push(task) {
        if (!task || stopped) {
          return false;
        }
        if (task.key && activeKeys.has(task.key)) {
          return false;
        }
        if (task.key) {
          activeKeys.add(task.key);
        }
        waiting.push(task);
        pump();
        return true;
      },
      stop() {
        stopped = true;
        waiting.length = 0;
        activeKeys.clear();
      },
      stats() {
        return { loaded: counts.loaded, failed: counts.failed, running: counts.running, pending: waiting.length };
      },
      whenIdle() {
        return new Promise((resolve) => {
          const poll = () => {
            if (counts.running === 0 && waiting.length === 0) {
              resolve();
            } else {
              setTimeout(poll, 1);
            }
          };
          poll();
        });
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Persistence (defensive about private mode, quota and corrupt entries)
   * ------------------------------------------------------------------ */

  const CACHE_PREFIX = '$vl2#';
  const CONFIG_ENTRY = '~config';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 500;

  function createStore(storage, options = {}) {
    const prefix = options.prefix || CACHE_PREFIX;
    const ttl = options.ttl === undefined ? CACHE_TTL_MS : options.ttl;
    const maxEntries = options.maxEntries === undefined ? CACHE_MAX_ENTRIES : options.maxEntries;
    const backend = storage || null;
    const memory = new Map();

    function rawRead(key) {
      if (memory.has(key)) {
        return memory.get(key);
      }
      if (!backend) {
        return undefined;
      }
      try {
        const value = backend.getItem(prefix + key);
        return value === null ? undefined : value;
      } catch (error) {
        return undefined;
      }
    }

    function rawWrite(key, value) {
      memory.set(key, value);
      if (!backend) {
        return;
      }
      try {
        backend.setItem(prefix + key, value);
      } catch (error) {
        // Quota exceeded or storage disabled: drop half the cache and retry once.
        try {
          prune(true);
          backend.setItem(prefix + key, value);
        } catch (retryError) {
          // Pruning may have evicted the entry we are writing; restore it so the
          // in-memory copy still serves this page load.
          memory.set(key, value);
        }
      }
    }

    function remove(key) {
      memory.delete(key);
      if (!backend) {
        return;
      }
      try {
        backend.removeItem(prefix + key);
      } catch (error) {
        /* ignore */
      }
    }

    function keys() {
      let result = [];
      if (backend) {
        try {
          for (let i = 0; i < backend.length; i += 1) {
            const key = backend.key(i);
            if (typeof key === 'string' && key.startsWith(prefix)) {
              result.push(key.slice(prefix.length));
            }
          }
        } catch (error) {
          result = [];
        }
      }
      memory.forEach((value, key) => {
        if (!result.includes(key)) {
          result.push(key);
        }
      });
      return result.filter((key) => key !== CONFIG_ENTRY);
    }

    function parseDurationEntry(raw) {
      if (typeof raw !== 'string') {
        return null;
      }
      try {
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.v !== 'number' || typeof entry.t !== 'number') {
          return null;
        }
        return entry;
      } catch (error) {
        return null;
      }
    }

    function prune(force = false) {
      const now = Date.now();
      const entries = [];
      keys().forEach((key) => {
        const entry = parseDurationEntry(rawRead(key));
        if (!entry || (ttl > 0 && now - entry.t > ttl)) {
          remove(key);
          return;
        }
        entries.push({ key, t: entry.t });
      });
      // A forced prune (quota pressure) only halves the cache; a normal one trims
      // back to the cap. Either way a tiny cache is left alone.
      const keep = force ? Math.max(1, Math.floor(maxEntries / 2)) : maxEntries;
      if (entries.length <= keep) {
        return;
      }
      entries
        .sort((a, b) => a.t - b.t)
        .slice(0, entries.length - keep)
        .forEach((entry) => remove(entry.key));
    }

    return {
      getDuration(key) {
        const raw = rawRead(key);
        if (raw === undefined) {
          return null;
        }
        const entry = parseDurationEntry(raw);
        if (!entry || (ttl > 0 && Date.now() - entry.t > ttl)) {
          remove(key);
          return null;
        }
        return entry.v;
      },
      setDuration(key, milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
          return;
        }
        rawWrite(key, JSON.stringify({ v: milliseconds, t: Date.now() }));
        prune();
      },
      getConfig() {
        const raw = rawRead(CONFIG_ENTRY);
        if (typeof raw !== 'string') {
          return null;
        }
        try {
          const parsed = JSON.parse(raw);
          return parsed && parsed.v && typeof parsed.v === 'object' ? parsed.v : null;
        } catch (error) {
          remove(CONFIG_ENTRY);
          return null;
        }
      },
      setConfig(config) {
        rawWrite(CONFIG_ENTRY, JSON.stringify({ v: config, t: Date.now() }));
      },
      clear() {
        keys().forEach((key) => remove(key));
      },
      prune,
      keys,
    };
  }

  /* ------------------------------------------------------------------ *
   * Network
   * ------------------------------------------------------------------ */

  function requestBytes(url, range, extraHeaders) {
    return new Promise((resolve, reject) => {
      if (typeof GM === 'undefined' || typeof GM.xmlHttpRequest !== 'function') {
        reject(probeError('GM.xmlHttpRequest unavailable', false));
        return;
      }
      let settled = false;
      let request = null;
      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        try {
          if (request && typeof request.abort === 'function') {
            request.abort();
          }
        } catch (error) {
          /* ignore */
        }
        finish(new Error('timeout'));
      }, 20000);

      const headers = Object.assign(
        {
          Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
          Referer: 'https://www.erome.com/',
        },
        range ? { Range: range } : {},
        extraHeaders || {},
      );

      try {
        request = GM.xmlHttpRequest({
          url,
          method: 'GET',
          headers,
          responseType: 'arraybuffer',
          timeout: 20000,
          onprogress(response) {
            if (!settled && response && response.loaded > MAX_RESPONSE_BYTES) {
              try {
                if (request && typeof request.abort === 'function') {
                  request.abort();
                }
              } catch (error) {
                /* ignore */
              }
              finish(new Error('response too large'));
            }
          },
          onload(response) {
            if (response && typeof response.status === 'number' && response.status >= 400) {
              // 403/404 will not improve on a retry; throttling and timeouts might.
              const retryable = response.status === 408 || response.status === 429;
              finish(probeError(`HTTP ${response.status}`, retryable));
              return;
            }
            const body = response ? response.response : null;
            if (body instanceof ArrayBuffer) {
              if (body.byteLength > MAX_RESPONSE_BYTES) {
                finish(probeError('response too large', false));
                return;
              }
              finish(null, new Uint8Array(body));
              return;
            }
            if (body && typeof body.byteLength === 'number') {
              finish(null, new Uint8Array(body));
              return;
            }
            finish(new Error('empty response'));
          },
          onerror() {
            finish(new Error('network error'));
          },
          onabort() {
            finish(new Error('aborted'));
          },
          ontimeout() {
            finish(new Error('timeout'));
          },
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  /**
   * Resolves a video's duration: cache first, then the first bytes of the file,
   * then (MP4 only) the tail, where `moov` is commonly stored.
   */
  async function resolveDuration(url, store, extraHeaders, options = {}) {
    const cached = store.getDuration(url);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    const shouldThrow = Boolean(options.throwOnFailure);
    let duration = null;
    try {
      const head = await requestBytes(url, `bytes=0-${MAX_HEAD_BYTES}`, extraHeaders);
      duration = parseDurationBytes(head);
      const container = sniffContainer(head);
      if (duration === null && container === 'mp4') {
        // moov often lives at the end of an MP4.
        const tail = await requestBytes(url, `bytes=-${MAX_TAIL_BYTES}`, extraHeaders);
        duration = parseMp4Duration(tail);
      } else if (duration === null && container === 'webm') {
        // Some WebM files carry large metadata ahead of Info.
        const wider = await requestBytes(url, `bytes=0-${MAX_HEAD_RETRY_BYTES - 1}`, extraHeaders);
        duration = parseEbmlDuration(wider);
      }
    } catch (error) {
      // A failed probe must never break the page; the UI just stays quiet
      // unless the caller asked for the failure so it can be retried.
      if (shouldThrow) {
        throw error;
      }
      return null;
    }
    if (duration !== null && duration > 0) {
      store.setDuration(url, duration);
      return duration;
    }
    if (shouldThrow) {
      // A head that parsed but carried no duration may be a truncation, so it is
      // worth one bounded retry.
      throw probeError('duration not found', true);
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function ensureStyle() {
    if (document.getElementById('erome-vl-style')) {
      return;
    }
    const style = document.createElement('style');
    style.id = 'erome-vl-style';
    style.textContent = [
      `.${HIDDEN_CLASS}{display:none!important}`,
      '.erome-vl-link{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;font-size:12px}',
      '.erome-vl-duration{font-weight:bold;font-variant-numeric:tabular-nums}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function setHidden(element, hidden) {
    if (!element) {
      return;
    }
    element.classList.toggle(HIDDEN_CLASS, hidden);
  }

  /* ------------------------------------------------------------------ *
   * Feature wiring
   * ------------------------------------------------------------------ */

  function boot() {
    const storage = (() => {
      try {
        const probe = '__erome_vl_probe__';
        window.localStorage.setItem(probe, '1');
        window.localStorage.removeItem(probe);
        return window.localStorage;
      } catch (error) {
        return null;
      }
    })();

    const store = createStore(storage);
    const saved = store.getConfig() || {};

    const state = {
      minSeconds: Number(saved.minSeconds) || 0,
      onlyVideos: 0,
      privateMode: Boolean(saved.privateMode),
      persist() {
        // Preferences are harmless to keep; private mode only governs the
        // media-derived duration cache.
        store.setConfig({
          minSeconds: state.minSeconds,
          onlyVideos: state.onlyVideos,
          privateMode: state.privateMode,
        });
      },
    };

    // Honouring Global Privacy Control on our own requests, and caching nothing,
    // is the only "privacy control" a page script can legitimately offer.
    const privacyHeaders = () => (state.privateMode ? { 'Sec-GPC': '1', DNT: '1' } : {});

    // Private mode is read on every call so toggling it takes effect immediately.
    const durationStore = {
      getDuration(key) {
        return state.privateMode ? null : store.getDuration(key);
      },
      setDuration(key, milliseconds) {
        if (!state.privateMode) {
          store.setDuration(key, milliseconds);
        }
      },
    };

    const durations = new Map(); // url -> milliseconds
    const pendingTargets = new Map(); // url -> [{ anchor, video }]
    const isAlbum = document.location.pathname.startsWith('/a/');

    // Three probes in flight: enough to fill a page quickly, small enough that a
    // long album does not exhaust the connection budget.
    const queue = createTaskQueue({
      concurrency: 3,
      maxAttempts: 3,
      baseDelay: 750,
      maxDelay: 8000,
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    });

    function refreshStatus() {
      const status = document.getElementById('erome-vl-status');
      if (!status) {
        return;
      }
      const { pending, running, failed } = queue.stats();
      const parts = [`${durations.size} loaded`];
      if (pending + running > 0) {
        parts.push(`${pending + running} loading`);
      }
      if (failed > 0) {
        parts.push(`${failed} unavailable`);
      }
      status.textContent = parts.join(' \u00b7 ');
    }

    let filterActive = false;

    function applyFilter() {
      if (!filterActive) {
        return;
      }
      const minimum = state.minSeconds;
      document.querySelectorAll('.video').forEach((container) => {
        const video = container.querySelector('.player video, video');
        const length = video ? Number(video.dataset.length) : NaN;
        setHidden(container, minimum > 0 && Number.isFinite(length) && length < minimum);
      });
    }

    function maxKnownSeconds() {
      let max = 0;
      durations.forEach((milliseconds) => {
        max = Math.max(max, Math.floor(milliseconds / 1000));
      });
      return max;
    }

    let slider = null;
    let output = null;

    function renderPanel() {
      if (!document.getElementById('erome-vl-panel')) {
        ensureStyle();
        const panel = document.createElement('div');
        panel.id = 'erome-vl-panel';
        panel.setAttribute('style', 'position:fixed;right:0;top:50px;z-index:9999;background:rgba(0,0,0,.75);color:#fff;padding:6px 10px;border-radius:4px;font:12px/1.4 sans-serif');

        const label = document.createElement('label');
        label.htmlFor = 'erome-vl-minlength';
        label.textContent = 'Minimal length';
        output = document.createElement('output');
        output.id = 'erome-vl-output';
        output.setAttribute('style', 'margin-left:6px;font-weight:bold');
        label.appendChild(output);

        slider = document.createElement('input');
        slider.type = 'range';
        slider.id = 'erome-vl-minlength';
        slider.step = '1';
        slider.min = '0';
        slider.max = '60';

        slider.addEventListener('input', () => {
          const seconds = Number(slider.value);
          state.minSeconds = Number.isFinite(seconds) ? seconds : 0;
          renderOutput();
          applyFilter();
          state.persist();
        });

        const status = document.createElement('span');
        status.id = 'erome-vl-status';
        status.setAttribute('style', 'display:block;font-size:11px;opacity:.75;margin-top:2px');
        status.textContent = 'Loading\u2026';

        panel.appendChild(label);
        panel.appendChild(document.createElement('br'));
        panel.appendChild(slider);
        panel.appendChild(status);
        (document.body || document.documentElement).appendChild(panel);
      }
      filterActive = true;
      updateSliderBounds();
      slider.value = String(Math.min(Number(slider.max), Math.max(0, state.minSeconds)));
      renderOutput();
      applyFilter();
      refreshStatus();
    }

    function renderOutput() {
      if (!slider || !output) {
        return;
      }
      const seconds = Number(slider.value);
      output.textContent = seconds > 0 ? formatDuration(seconds * 1000) : 'Off';
    }

    function updateSliderBounds() {
      if (!slider) {
        return;
      }
      // Never clamp a remembered value: the range has to include it.
      const max = Math.max(60, maxKnownSeconds(), Math.ceil(state.minSeconds));
      if (slider.max !== String(max)) {
        slider.max = String(max);
      }
      if (Number(slider.value) > max) {
        slider.value = String(max);
      }
    }

    function attachDuration(url, anchor, video, milliseconds) {
      const text = formatDuration(milliseconds);
      if (anchor && !anchor.dataset.eromeVlDone) {
        anchor.dataset.eromeVlDone = '1';
        const span = document.createElement('span');
        span.className = 'erome-vl-duration';
        span.style.marginRight = '4px';
        span.textContent = text;
        span.title = `${Math.floor(milliseconds / 1000)} seconds`;
        if (anchor.parentNode) {
          anchor.parentNode.insertBefore(span, anchor);
          anchor.parentNode.insertBefore(document.createTextNode(' '), anchor);
        }
      }
      if (video && video.dataset) {
        video.dataset.length = String(Math.floor(milliseconds / 1000));
      }
      updateSliderBounds();
      renderOutput();
      applyFilter();
      refreshStatus();
    }

    /**
     * Queues a probe for `url`, remembering every anchor that is waiting for it.
     * Repeat calls for the same URL share one request instead of stacking up.
     */
    function enhance(url, anchor, video) {
      const known = durations.get(url);
      if (known !== undefined) {
        attachDuration(url, anchor, video, known);
        return;
      }
      const existing = pendingTargets.get(url);
      if (existing) {
        existing.push({ anchor, video });
        return;
      }
      pendingTargets.set(url, [{ anchor, video }]);
      const queued = queue.push({
        key: url,
        run: () => resolveDuration(url, durationStore, privacyHeaders(), { throwOnFailure: true }),
        onSuccess(milliseconds) {
          const targets = pendingTargets.get(url) || [];
          pendingTargets.delete(url);
          durations.set(url, milliseconds);
          targets.forEach((target) => attachDuration(url, target.anchor, target.video, milliseconds));
          refreshStatus();
        },
        onFailure(error) {
          pendingTargets.delete(url);
          if (anchor) {
            anchor.dataset.eromeVlDone = '1';
          }
          console.warn('[erome-vl] probe failed:', url, error && error.message);
          refreshStatus();
        },
      });
      if (!queued) {
        pendingTargets.delete(url);
      }
      refreshStatus();
    }

    function collectVideos() {
      let added = 0;
      document.querySelectorAll('.player video source, .player video').forEach((element) => {
        const source = element.tagName === 'SOURCE' ? element : element.querySelector('source') || element;
        const url = source.src || source.getAttribute('src');
        if (!url || !/^https?:/i.test(url)) {
          return;
        }
        const player = source.closest('.player') || source.parentNode.parentNode;
        if (!player || player.dataset.eromeVlBound) {
          return;
        }
        player.dataset.eromeVlBound = '1';
        const anchor = document.createElement('a');
        anchor.className = 'erome-vl-link';
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = url;
        if (player.parentNode) {
          player.parentNode.insertBefore(anchor, player);
        }
        added += 1;
        enhance(url, anchor, source.closest('video') || element);
      });
      return added;
    }

    function applyOnlyVideos() {
      const minimum = state.onlyVideos;
      if (isAlbum) {
        document.querySelectorAll('.media-group').forEach((group) => {
          setHidden(group, minimum > 0 && !group.querySelector('.video'));
        });
        return;
      }
      document.querySelectorAll('.album').forEach((album) => {
        if (minimum <= 0) {
          setHidden(album, false);
          return;
        }
        const counter = album.querySelector('.album-videos');
        const count = counter && counter.textContent ? parseInt(counter.textContent, 10) : 0;
        setHidden(album, !(Number.isFinite(count) && count >= minimum));
      });
    }

    function maxAlbumVideoCount() {
      let max = 0;
      document.querySelectorAll('.album').forEach((album) => {
        const counter = album.querySelector('.album-videos');
        const count = counter && counter.textContent ? parseInt(counter.textContent, 10) : 0;
        if (Number.isFinite(count)) {
          max = Math.max(max, count);
        }
      });
      return max;
    }

    function setOnlyVideos(count, updateHash = true) {
      state.onlyVideos = Math.max(0, count);
      if (updateHash) {
        const hash = buildHash(state.onlyVideos);
        if (hash) {
          if (document.location.hash !== hash) {
            document.location.hash = hash;
          }
        } else if (document.location.hash) {
          try {
            history.replaceState(null, '', document.location.pathname + document.location.search);
          } catch (error) {
            document.location.hash = '';
          }
        }
      }
      ensureStyle();
      applyOnlyVideos();
      updateNavLink();
      state.persist();
    }

    let navLink = null;

    function updateNavLink() {
      if (!navLink) {
        return;
      }
      navLink.textContent = state.onlyVideos > 0 ? `only videos (${state.onlyVideos}+)` : 'only videos';
      navLink.href = buildHash(state.onlyVideos + 1) || '#';
    }

    function installNavItem() {
      const nav = document.querySelector('#app-navbar-collapse ul.navbar-right');
      if (!nav || nav.dataset.eromeVlNav) {
        return;
      }
      nav.dataset.eromeVlNav = '1';
      const item = nav.appendChild(document.createElement('li'));
      navLink = item.appendChild(document.createElement('a'));
      navLink.title = 'Left click: raise the minimum video count. Right click: turn off.';
      navLink.textContent = 'only videos';
      navLink.addEventListener('click', (event) => {
        event.preventDefault();
        // Wrap back to "off" once every album on the page has been included.
        const cap = isAlbum ? 1 : maxAlbumVideoCount();
        const next = state.onlyVideos + 1;
        setOnlyVideos(next > cap ? 0 : next);
      });
      navLink.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        setOnlyVideos(0);
      });
    }

    if (document.querySelectorAll('video').length > 1) {
      renderPanel();
    }

    const SWEEP_BASE_MS = 4000;
    const SWEEP_MAX_MS = 60000;
    let sweepDelay = SWEEP_BASE_MS;
    let sweepTimer = null;

    function clearSweep() {
      if (sweepTimer !== null && typeof window.clearTimeout === 'function') {
        window.clearTimeout(sweepTimer);
      }
      sweepTimer = null;
    }

    /**
     * Re-scans the page over and over: fast while new players keep appearing,
     * backing off to a minute once the page is stable, paused while hidden.
     */
    function scheduleSweep(delay) {
      clearSweep();
      if (document.visibilityState === 'hidden') {
        return;
      }
      sweepDelay = delay === undefined ? sweepDelay : delay;
      sweepTimer = window.setTimeout(() => {
        sweepTimer = null;
        const added = collectVideos();
        scheduleSweep(nextSweepDelay(sweepDelay, added > 0, SWEEP_BASE_MS, SWEEP_MAX_MS));
      }, sweepDelay);
    }

    collectVideos();
    window.requestAnimationFrame(collectVideos);
    scheduleSweep();

    installNavItem();
    setOnlyVideos(parseHash(document.location.hash).onlyVideos || 0, false);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        collectVideos();
        scheduleSweep(SWEEP_BASE_MS);
      } else {
        clearSweep();
      }
    });

    if (typeof MutationObserver === 'function' && document.body) {
      let scheduled = false;
      const observer = new MutationObserver((records) => {
        if (scheduled) {
          return;
        }
        const relevant = records.some((record) => Array.from(record.addedNodes).some(
          (node) => node && node.nodeType === 1 && (
            (typeof node.matches === 'function' && node.matches('video, .player, .video'))
            || (typeof node.querySelector === 'function' && node.querySelector('video'))
          ),
        ));
        if (!relevant) {
          return;
        }
        scheduled = true;
        window.setTimeout(() => {
          scheduled = false;
          collectVideos();
          scheduleSweep(SWEEP_BASE_MS);
        }, 300);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('hashchange', () => {
      const parsed = parseHash(document.location.hash).onlyVideos || 0;
      if (parsed !== state.onlyVideos) {
        setOnlyVideos(parsed, false);
      }
    });

    if (typeof GM !== 'undefined' && typeof GM.registerMenuCommand === 'function') {
      try {
        GM.registerMenuCommand('Private mode (GPC headers, nothing cached)', () => {
          state.privateMode = !state.privateMode;
          if (state.privateMode) {
            store.clear();
          }
          state.persist();
          console.info(`[erome-vl] private mode ${state.privateMode ? 'on' : 'off'}`);
        });
      } catch (error) {
        /* the menu entry is a nicety, never a requirement */
      }
    }
  }

  const api = {
    formatDuration,
    parseEbmlDuration,
    parseMp4Duration,
    parseDurationBytes,
    parseHash,
    buildHash,
    sniffContainer,
    readVint,
    createStore,
    createTaskQueue,
    nextSweepDelay,
    probeError,
    resolveDuration,
    requestBytes,
    MAX_HEAD_BYTES,
    MAX_TAIL_BYTES,
  };

  if (typeof module === 'object' && module && module.exports && typeof process === 'object') {
    module.exports = api;
  }

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  try {
    boot();
  } catch (error) {
    // Never take the page down with us.
    console.warn('[erome-vl]', error);
  }
}());
