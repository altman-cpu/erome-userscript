'use strict';

/*
 * GRID//CORE — client-first operational terminal for this repository.
 *
 * The file is deliberately split in two halves:
 *
 *   1. Engine core  — pure, DOM-free, exported for the Node test-suite
 *                     (container parsing, cache, proxy queue, privacy policy,
 *                     diagnostics). No network happens here on its own.
 *   2. Terminal UI  — everything that touches `document`. Built with DOM
 *                     primitives only: no innerHTML, no eval, no inline styles.
 *
 * Everything the page does with the network goes through `createEngine()`, the
 * single proxy layer. Nothing else in the app calls `fetch`.
 */

(function () {
  const HUD_VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const MAX_HEAD_BYTES = 256 * 1024;
  const MAX_TAIL_BYTES = 512 * 1024;
  const DEFAULT_TIMEOUT_MS = 15000;
  const CACHE_PREFIX = 'hud#';
  const SETTINGS_PREFIX = 'hud~';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 500;
  const PROFILE_KEY = 'profile';
  const PROBE_LIMIT = 40;
  const LOG_LIMIT = 240;
  const ROW_LIMIT = 80;

  const SCHEMES = new Set(['http:', 'https:', 'demo:']);

  /* ------------------------------------------------------------------ *
   * Formatting helpers
   * ------------------------------------------------------------------ */

  /** `m:ss` / `h:mm:ss`, or '' for anything that is not a usable duration. */
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

  /** 0 B / 1.4 KB / 12.3 MB — binary units, one decimal above 1 KB. */
  function formatBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return '0 B';
    }
    if (value < 1024) {
      return `${Math.round(value)} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(1)} ${units[unit]}`;
  }

  /** Compact age for cache rows: `12s`, `4m`, `3h`, `6d`. */
  function formatAge(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
      return '—';
    }
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
      return `${hours}h`;
    }
    return `${Math.floor(hours / 24)}d`;
  }

  /* ------------------------------------------------------------------ *
   * Byte readers — shared by both container parsers
   * ------------------------------------------------------------------ */

  function readUint32(bytes, position) {
    return (
      bytes[position] * 0x1000000 +
      ((bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3])
    );
  }

  function readUint64(bytes, position) {
    const high = readUint32(bytes, position);
    const low = readUint32(bytes, position + 4);
    return high * 0x100000000 + low;
  }

  function readType(bytes, position) {
    let text = '';
    for (let i = 0; i < 4; i += 1) {
      text += String.fromCharCode(bytes[position + i]);
    }
    return text;
  }

  /**
   * An ISO-BMFF duration is a scaled 32/64-bit counter inside `mvhd`, which
   * lives in `moov`. Fast-start files put `moov` first; files written by a
   * muxer that streams put it last, which is why the engine may ask for a tail
   * range as well.
   */
  function parseMp4Duration(bytes) {
    if (!bytes || bytes.length < 32) {
      return null;
    }
    let position = 0;
    const limit = Math.min(bytes.length, MAX_TAIL_BYTES);
    while (position + 8 <= limit) {
      const size = readUint32(bytes, position);
      const type = readType(bytes, position + 4);
      let header = 8;
      let boxSize = size;
      if (size === 1) {
        if (position + 16 > limit) {
          break;
        }
        boxSize = readUint64(bytes, position + 8);
        header = 16;
      } else if (size === 0) {
        boxSize = limit - position;
      }
      if (boxSize < header) {
        break;
      }
      const end = Math.min(position + boxSize, limit);
      if (type === 'moov') {
        return findMvhd(bytes, position + header, end);
      }
      position = end;
    }
    return scanForMvhd(bytes) || null;
  }

  function findMvhd(bytes, start, end) {
    let position = start;
    while (position + 8 <= end) {
      const size = readUint32(bytes, position);
      const type = readType(bytes, position + 4);
      let header = 8;
      let boxSize = size;
      if (size === 1) {
        if (position + 16 > end) {
          return null;
        }
        boxSize = readUint64(bytes, position + 8);
        header = 16;
      } else if (size === 0) {
        boxSize = end - position;
      }
      if (boxSize < header) {
        return null;
      }
      if (type === 'mvhd') {
        return readMvhdPayload(bytes, position + header, Math.min(position + boxSize, end));
      }
      position = Math.min(position + boxSize, end);
    }
    return null;
  }

  function readMvhdPayload(bytes, offset, end) {
    if (offset + 4 > end) {
      return null;
    }
    const version = bytes[offset];
    let timescale = 0;
    let duration = 0;
    if (version === 1) {
      if (offset + 32 > end) {
        return null;
      }
      timescale = readUint32(bytes, offset + 20);
      duration = readUint64(bytes, offset + 24);
    } else {
      if (offset + 20 > end) {
        return null;
      }
      timescale = readUint32(bytes, offset + 12);
      duration = readUint32(bytes, offset + 16);
    }
    if (!timescale || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }
    return (duration / timescale) * 1000;
  }

  /** Last resort for a truncated `moov`: walk straight to the `mvhd` tag. */
  function scanForMvhd(bytes) {
    for (let position = 4; position + 20 <= bytes.length; position += 1) {
      if (bytes[position] !== 0x6d || bytes[position + 1] !== 0x76 || bytes[position + 2] !== 0x68 || bytes[position + 3] !== 0x64) {
        continue;
      }
      const parsed = readMvhdPayload(bytes, position + 4, bytes.length);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }

  const EBML_ID = {
    SEGMENT: 0x18538067,
    INFO: 0x1549a966,
    TIMECODE_SCALE: 0x2ad7b1,
    DURATION: 0x4489,
  };

  /** Reads an EBML element id, marker bits included. */
  function readEbmlId(bytes, position) {
    if (position >= bytes.length) {
      return null;
    }
    const first = bytes[position];
    if (first === 0) {
      return null;
    }
    let width = 1;
    let mask = 0x80;
    while (width <= 4 && (first & mask) === 0) {
      mask >>= 1;
      width += 1;
    }
    if (width > 4 || position + width > bytes.length) {
      return null;
    }
    let id = 0;
    for (let i = 0; i < width; i += 1) {
      id = id * 256 + bytes[position + i];
    }
    return { id, width };
  }

  /** Reads an EBML variable-length size. `unknown` is the reserved all-ones form. */
  function readEbmlSize(bytes, position) {
    if (position >= bytes.length) {
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
      value = value * 256 + bytes[position + i];
      allOnes = allOnes && bytes[position + i] === 0xff;
    }
    return { value, width, unknown: allOnes };
  }

  function readEbmlUint(bytes, start, end) {
    let value = 0;
    for (let i = start; i < end && i < start + 8; i += 1) {
      value = value * 256 + bytes[i];
    }
    return value;
  }

  function readEbmlFloat(bytes, start, end) {
    const width = end - start;
    if (width === 4 || width === 8) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + start, width);
      return width === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
    }
    return null;
  }

  /**
   * Matroska/WebM keeps `Duration` (a float, in timecode ticks) and
   * `TimecodeScale` (nanoseconds per tick, default 1 000 000) inside `Info`.
   */
  function parseWebmDuration(bytes) {
    if (!bytes || bytes.length < 16) {
      return null;
    }
    const state = { timecodeScale: 1000000, duration: null };
    walkEbml(bytes, 0, bytes.length, state, 0);
    if (state.duration === null || !(state.duration > 0)) {
      return null;
    }
    return (state.duration * state.timecodeScale) / 1e6;
  }

  function walkEbml(bytes, start, end, state, depth) {
    if (depth > 6) {
      return;
    }
    let position = start;
    while (position < end) {
      const id = readEbmlId(bytes, position);
      if (!id) {
        return;
      }
      const size = readEbmlSize(bytes, position + id.width);
      if (!size) {
        return;
      }
      const payloadStart = position + id.width + size.width;
      const payloadEnd = size.unknown ? end : Math.min(end, payloadStart + size.value);
      if (payloadEnd < payloadStart) {
        return;
      }
      if (id.id === EBML_ID.SEGMENT || id.id === EBML_ID.INFO) {
        walkEbml(bytes, payloadStart, payloadEnd, state, depth + 1);
      } else if (id.id === EBML_ID.TIMECODE_SCALE) {
        const scale = readEbmlUint(bytes, payloadStart, payloadEnd);
        if (scale > 0) {
          state.timecodeScale = scale;
        }
      } else if (id.id === EBML_ID.DURATION) {
        const value = readEbmlFloat(bytes, payloadStart, payloadEnd);
        if (value !== null && Number.isFinite(value) && value > 0) {
          state.duration = value;
        }
      }
      if (payloadEnd <= position) {
        return;
      }
      position = payloadEnd;
    }
  }

  /** `webm` for anything EBML-based, `mp4` for ISO-BMFF, `null` otherwise. */
  function sniffContainer(bytes) {
    if (!bytes || bytes.length < 12) {
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

  /** Duration in milliseconds plus the container that produced it, or null. */
  function durationFromBytes(bytes) {
    const container = sniffContainer(bytes);
    if (container === 'webm') {
      const milliseconds = parseWebmDuration(bytes);
      return milliseconds === null ? null : { ms: milliseconds, container };
    }
    if (container === 'mp4') {
      const milliseconds = parseMp4Duration(bytes);
      return milliseconds === null ? null : { ms: milliseconds, container };
    }
    const fallback = parseWebmDuration(bytes);
    if (fallback !== null) {
      return { ms: fallback, container: 'webm' };
    }
    const fragmented = parseMp4Duration(bytes);
    return fragmented === null ? null : { ms: fragmented, container: 'mp4' };
  }

  /* ------------------------------------------------------------------ *
   * Synthetic fixtures — used by the diagnostics panel and the tests so the
   * parsers can be exercised against real container layouts with no network.
   * ------------------------------------------------------------------ */

  function writeUint32(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
  }

  function writeType(target, offset, type) {
    for (let i = 0; i < 4; i += 1) {
      target[offset + i] = type.charCodeAt(i);
    }
  }

  /** A minimal but structurally valid MP4: `ftyp` + `moov(mvhd)`. */
  function buildMp4Fixture(seconds, options) {
    const settings = options || {};
    const timescale = settings.timescale || 1000;
    const version = settings.version === 1 ? 1 : 0;
    const duration = Math.max(1, Math.round(seconds * timescale));

    const ftyp = new Uint8Array(24);
    writeUint32(ftyp, 0, ftyp.length);
    writeType(ftyp, 4, 'ftyp');
    writeType(ftyp, 8, 'isom');
    writeUint32(ftyp, 12, 512);
    writeType(ftyp, 16, 'isom');
    writeType(ftyp, 20, 'iso2');

    const payloadSize = version === 1 ? 112 : 100;
    const mvhd = new Uint8Array(8 + payloadSize);
    writeUint32(mvhd, 0, mvhd.length);
    writeType(mvhd, 4, 'mvhd');
    const body = 8;
    mvhd[body] = version;
    if (version === 1) {
      writeUint32(mvhd, body + 20, timescale);
      writeUint32(mvhd, body + 24, 0);
      writeUint32(mvhd, body + 28, duration);
    } else {
      writeUint32(mvhd, body + 12, timescale);
      writeUint32(mvhd, body + 16, duration);
    }

    const moov = new Uint8Array(8 + mvhd.length);
    writeUint32(moov, 0, moov.length);
    writeType(moov, 4, 'moov');
    moov.set(mvhd, 8);

    const output = new Uint8Array(ftyp.length + moov.length);
    output.set(ftyp, 0);
    output.set(moov, ftyp.length);
    return output;
  }

  function encodeEbmlSize(value) {
    let width = 1;
    while (width <= 8 && value >= Math.pow(2, 7 * width) - 1) {
      width += 1;
    }
    const bytes = new Uint8Array(width);
    let rest = value;
    for (let i = width - 1; i >= 0; i -= 1) {
      bytes[i] = rest & 0xff;
      rest = Math.floor(rest / 256);
    }
    bytes[0] |= 0x80 >> (width - 1);
    return bytes;
  }

  function ebmlElement(idBytes, payload) {
    const size = encodeEbmlSize(payload.length);
    const output = new Uint8Array(idBytes.length + size.length + payload.length);
    output.set(idBytes, 0);
    output.set(size, idBytes.length);
    output.set(payload, idBytes.length + size.length);
    return output;
  }

  function concatBytes(parts) {
    let total = 0;
    parts.forEach((part) => {
      total += part.length;
    });
    const output = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  /** Minimal big-endian unsigned integer, at least one byte wide. */
  function encodeEbmlUint(value) {
    const bytes = [];
    let rest = Math.max(0, Math.round(value));
    do {
      bytes.unshift(rest & 0xff);
      rest = Math.floor(rest / 256);
    } while (rest > 0);
    return new Uint8Array(bytes);
  }

  /** A minimal WebM/Matroska file: EBML header + Segment(Info(TimecodeScale, Duration)). */
  function buildWebmFixture(seconds, options) {
    const settings = options || {};
    const timecodeScale = settings.timecodeScale || 1000000;
    const ticks = (seconds * 1e9) / timecodeScale;

    const duration = new Uint8Array(8);
    new DataView(duration.buffer).setFloat64(0, ticks, false);
    const scale = encodeEbmlUint(timecodeScale);

    const info = ebmlElement(
      new Uint8Array([0x15, 0x49, 0xa9, 0x66]),
      concatBytes([
        ebmlElement(new Uint8Array([0x2a, 0xd7, 0xb1]), scale),
        ebmlElement(new Uint8Array([0x44, 0x89]), duration),
      ]),
    );

    const segment = ebmlElement(new Uint8Array([0x18, 0x53, 0x80, 0x67]), info);
    const header = ebmlElement(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array([0x42, 0x82, 0x88]));
    return concatBytes([header, segment]);
  }

  function buildCorruptFixture() {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 37 + 11) & 0xff;
    }
    return bytes;
  }

  /* ------------------------------------------------------------------ *
   * Cache — `{v, t}` entries, exactly the shape the userscript writes, so the
   * two can be reasoned about together. A null backend makes it memory-only,
   * which is what the GHOST profile needs.
   * ------------------------------------------------------------------ */

  function createCache(config) {
    const settings = config || {};
    const backend = settings.storage || null;
    const prefix = settings.prefix || CACHE_PREFIX;
    const ttl = Number.isFinite(settings.ttl) ? settings.ttl : CACHE_TTL_MS;
    const maxEntries = Number.isInteger(settings.maxEntries) && settings.maxEntries > 0
      ? settings.maxEntries
      : CACHE_MAX_ENTRIES;
    const clock = settings.now || Date.now;
    const memory = new Map();

    function readRaw(key) {
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

    function writeRaw(key, value) {
      memory.set(key, value);
      if (!backend) {
        return;
      }
      try {
        backend.setItem(prefix + key, value);
      } catch (error) {
        try {
          prune(true);
          backend.setItem(prefix + key, value);
        } catch (retryError) {
          memory.set(key, value);
        }
      }
    }

    function parseEntry(raw) {
      if (typeof raw !== 'string') {
        return null;
      }
      try {
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.v !== 'number' || typeof entry.t !== 'number') {
          return null;
        }
        return { durationMs: entry.v, savedAt: entry.t };
      } catch (error) {
        return null;
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
        /* storage may be gone; memory already forgot it */
      }
    }

    function keys() {
      const result = [];
      if (backend) {
        try {
          for (let i = 0; i < backend.length; i += 1) {
            const key = backend.key(i);
            if (typeof key === 'string' && key.startsWith(prefix) && key !== prefix + SETTINGS_PREFIX + PROFILE_KEY) {
              result.push(key.slice(prefix.length));
            }
          }
        } catch (error) {
          /* enumerate what memory has instead */
        }
      }
      memory.forEach((value, key) => {
        if (!result.includes(key)) {
          result.push(key);
        }
      });
      return result;
    }

    function prune(force) {
      const now = clock();
      const entries = [];
      keys().forEach((key) => {
        const entry = parseEntry(readRaw(key));
        if (!entry || (ttl > 0 && now - entry.savedAt > ttl)) {
          remove(key);
          return;
        }
        entries.push({ key, savedAt: entry.savedAt });
      });
      const keep = force ? Math.max(1, Math.floor(maxEntries / 2)) : maxEntries;
      if (entries.length <= keep) {
        return;
      }
      entries
        .sort((a, b) => a.savedAt - b.savedAt)
        .slice(0, entries.length - keep)
        .forEach((entry) => remove(entry.key));
    }

    return {
      get(key) {
        const raw = readRaw(key);
        if (raw === undefined) {
          return null;
        }
        const entry = parseEntry(raw);
        if (!entry) {
          remove(key);
          return null;
        }
        if (ttl > 0 && clock() - entry.savedAt > ttl) {
          remove(key);
          return null;
        }
        return entry;
      },
      set(key, milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
          return;
        }
        writeRaw(key, JSON.stringify({ v: milliseconds, t: clock() }));
        prune(false);
      },
      remove,
      entries() {
        const list = [];
        keys().forEach((key) => {
          const entry = this.get(key);
          if (entry) {
            list.push({ key, durationMs: entry.durationMs, savedAt: entry.savedAt });
          }
        });
        return list.sort((a, b) => b.savedAt - a.savedAt);
      },
      stats() {
        const list = this.entries();
        let bytes = 0;
        list.forEach((entry) => {
          bytes += (prefix + entry.key).length + JSON.stringify({ v: entry.durationMs, t: entry.savedAt }).length;
        });
        return { count: list.length, bytes, ttl, maxEntries };
      },
      purge() {
        const removed = keys().length;
        keys().forEach((key) => remove(key));
        return removed;
      },
      exportJson() {
        return JSON.stringify(
          {
            exportedAt: new Date(clock()).toISOString(),
            prefix,
            entries: this.entries().map((entry) => ({
              key: entry.key,
              durationMs: entry.durationMs,
              savedAt: new Date(entry.savedAt).toISOString(),
            })),
          },
          null,
          2,
        );
      },
      backend: backend ? 'persistent' : 'memory',
    };
  }

  /* ------------------------------------------------------------------ *
   * Privacy profiles
   * ------------------------------------------------------------------ */

  const PROFILES = [
    {
      id: 'standard',
      label: 'STANDARD',
      ttl: CACHE_TTL_MS,
      maxEntries: CACHE_MAX_ENTRIES,
      logUrls: true,
      worker: 'full',
      remember: true,
      note: 'Durations cached for 30 days, targets printed in the console, service worker keeps the shell plus probed assets.',
    },
    {
      id: 'hardened',
      label: 'HARDENED',
      ttl: 24 * 60 * 60 * 1000,
      maxEntries: 150,
      logUrls: false,
      worker: 'shell',
      remember: true,
      note: 'Durations cached for one day and capped at 150 entries, targets redacted in the console, service worker keeps the shell only.',
    },
    {
      id: 'ghost',
      label: 'GHOST',
      ttl: 0,
      maxEntries: 0,
      logUrls: false,
      worker: 'shell',
      remember: false,
      note: 'Nothing is written to storage, results live in memory for this tab, no duration cache, no probe log retention.',
    },
  ];

  function findProfile(id) {
    for (let i = 0; i < PROFILES.length; i += 1) {
      if (PROFILES[i].id === id) {
        return PROFILES[i];
      }
    }
    return PROFILES[0];
  }

  /**
   * Turns a requested profile plus the browser's Global Privacy Control signal
   * into the settings the app actually runs with.
   */
  function resolvePolicy(requested, environment) {
    const env = environment || {};
    const gpc = env.gpc === true;
    const chosen = findProfile(requested);
    const effective = gpc ? findProfile('ghost') : chosen;
    return {
      id: effective.id,
      requested: chosen.id,
      label: effective.label,
      forcedByGpc: gpc && effective.id !== chosen.id,
      gpc,
      cacheEnabled: effective.ttl > 0,
      ttl: effective.ttl,
      maxEntries: effective.maxEntries,
      logUrls: effective.logUrls,
      worker: effective.worker,
      remember: effective.remember,
      note: env.gpcNote || effective.note,
    };
  }

  function detectGpc(nav) {
    const source = nav || (typeof navigator === 'undefined' ? null : navigator);
    return Boolean(source && source.globalPrivacyControl === true);
  }

  /** Only http(s) and the local `demo:` diagnostics scheme may be probed. */
  function normalizeTarget(raw, base) {
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    let url;
    try {
      url = new URL(trimmed, base || undefined);
    } catch (error) {
      return null;
    }
    if (!SCHEMES.has(url.protocol)) {
      return null;
    }
    return url;
  }

  /* ------------------------------------------------------------------ *
   * Proxy engine — the single path to the network.
   *
   *   probe(url) → result object (never rejects)
   *
   * Behaviour: dedupe in-flight work, cap concurrency, cache hits short-circuit,
   * retry throttling/timeouts/network errors with capped exponential backoff,
   * fail fast on 403/404/416 and metadata-less files.
   * ------------------------------------------------------------------ */

  function positiveInt(value, fallback, minimum) {
    if (!Number.isInteger(value) || value < (minimum === undefined ? 1 : minimum)) {
      return fallback;
    }
    return value;
  }

  function classifyStatus(status) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { retryable: true, error: `http-${status}` };
    }
    return { retryable: false, error: `http-${status}` };
  }

  function createEngine(config) {
    const options = config || {};
    const fetchImpl = options.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('createEngine needs a fetch implementation');
    }

    const concurrency = positiveInt(options.concurrency, 3);
    const retries = positiveInt(options.retries, 2, 0);
    const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const retryBaseMs = positiveInt(options.retryBaseMs, 750);
    const retryMaxMs = positiveInt(options.retryMaxMs, 8000);
    const clock = options.now || Date.now;
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const random = options.random || Math.random;
    const cache = options.cache || null;
    const cacheEnabled = options.cacheEnabled === undefined ? true : Boolean(options.cacheEnabled);
    const sameOriginOnly = options.sameOriginOnly === true;
    const origin = typeof options.origin === 'string' ? options.origin : null;
    const allowTail = options.allowTail !== false;
    const base = options.base;
    const listeners = new Set();

    const stats = {
      queued: 0,
      active: 0,
      ok: 0,
      failed: 0,
      retries: 0,
      deduped: 0,
      cacheHits: 0,
      bytes: 0,
      requests: 0,
      blocked: 0,
    };
    const waiting = [];
    const pending = new Map();
    let active = 0;
    let disposed = false;

    function emit(kind, detail) {
      listeners.forEach((listener) => {
        try {
          listener(kind, detail);
        } catch (error) {
          /* a bad listener must not break the queue */
        }
      });
    }

    function backoff(attempt) {
      const baseDelay = Math.min(retryMaxMs, retryBaseMs * Math.pow(2, attempt - 1));
      return baseDelay + Math.floor(random() * Math.max(1, baseDelay * 0.25));
    }

    function sleep(milliseconds) {
      return new Promise((resolve) => {
        setTimer(resolve, milliseconds);
      });
    }

    async function readCapped(response, limit) {
      const body = response.body;
      if (!body || typeof body.getReader !== 'function') {
        const buffer = await response.arrayBuffer();
        const all = new Uint8Array(buffer);
        const slice = all.length > limit ? all.subarray(0, limit) : all;
        return { bytes: slice, read: slice.length };
      }
      const reader = body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < limit) {
          const step = await reader.read();
          if (step.done) {
            break;
          }
          if (step.value && step.value.byteLength) {
            chunks.push(step.value);
            total += step.value.byteLength;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch (error) {
          /* already closed */
        }
      }
      const bytes = new Uint8Array(Math.min(total, limit));
      let offset = 0;
      for (let i = 0; i < chunks.length && offset < bytes.length; i += 1) {
        const take = Math.min(chunks[i].byteLength, bytes.length - offset);
        bytes.set(chunks[i].subarray(0, take), offset);
        offset += take;
      }
      return { bytes, read: offset };
    }

    async function requestRange(target, range, limit) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller) {
        timer = setTimer(() => controller.abort(), timeoutMs);
      }
      try {
        const response = await fetchImpl(target, {
          method: 'GET',
          headers: {
            Range: range,
            Accept: 'video/*,application/octet-stream;q=0.8,*/*;q=0.5',
          },
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal: controller ? controller.signal : undefined,
        });
        stats.requests += 1;
        if (!response.ok && response.status !== 206) {
          const verdict = classifyStatus(response.status);
          return { ok: false, retryable: verdict.retryable, error: verdict.error, read: 0 };
        }
        const capped = await readCapped(response, limit);
        return { ok: true, bytes: capped.bytes, read: capped.read, status: response.status };
      } catch (error) {
        const aborted = Boolean(error && (error.name === 'AbortError' || error.code === 20));
        return { ok: false, retryable: true, error: aborted ? 'timeout' : 'network', read: 0 };
      } finally {
        if (timer !== null) {
          clearTimer(timer);
        }
      }
    }

    async function attempt(target) {
      const head = await requestRange(target, `bytes=0-${MAX_HEAD_BYTES - 1}`, MAX_HEAD_BYTES);
      if (!head.ok) {
        return head;
      }
      let bytes = head.read;
      const found = durationFromBytes(head.bytes);
      if (found) {
        return { ok: true, durationMs: found.ms, container: found.container, bytes };
      }
      if (allowTail && sniffContainer(head.bytes) === 'mp4') {
        const tail = await requestRange(target, `bytes=-${MAX_TAIL_BYTES}`, MAX_TAIL_BYTES);
        if (tail.ok) {
          bytes += tail.read;
          const fromTail = durationFromBytes(tail.bytes);
          if (fromTail) {
            return { ok: true, durationMs: fromTail.ms, container: fromTail.container, bytes };
          }
        }
      }
      return { ok: false, retryable: false, error: 'no-duration', bytes };
    }

    async function execute(task) {
      const started = clock();
      let attempts = 0;
      let lastError = 'network';
      let lastBytes = 0;

      while (attempts <= retries) {
        attempts += 1;
        if (attempts > 1) {
          await sleep(backoff(attempts - 1));
          if (disposed) {
            break;
          }
        }
        const outcome = await attempt(task.target);
        lastBytes += outcome.read || outcome.bytes || 0;
        if (outcome.ok) {
          stats.bytes += lastBytes;
          return {
            ok: true,
            url: task.url,
            durationMs: outcome.durationMs,
            container: outcome.container || null,
            via: attempts > 1 ? 'retry' : 'network',
            bytes: lastBytes,
            attempts,
            elapsedMs: clock() - started,
          };
        }
        lastError = outcome.error;
        if (!outcome.retryable) {
          break;
        }
        if (attempts <= retries) {
          stats.retries += 1;
          emit('retry', { url: task.url, attempt: attempts + 1, error: lastError });
        }
      }

      stats.bytes += lastBytes;
      return {
        ok: false,
        url: task.url,
        error: lastError,
        bytes: lastBytes,
        attempts,
        elapsedMs: clock() - started,
      };
    }

    function settle(task, result) {
      active -= 1;
      stats.active = active;
      pending.delete(task.url);
      task.resolve(result);
      if (result.ok) {
        stats.ok += 1;
        if (cache && cacheEnabled) {
          cache.set(task.url, result.durationMs);
        }
      } else {
        stats.failed += 1;
      }
      emit('settled', result);
      emit('stats', Object.assign({}, stats));
      pump();
    }

    function pump() {
      while (!disposed && active < concurrency && waiting.length > 0) {
        const task = waiting.shift();
        active += 1;
        stats.active = active;
        stats.queued = waiting.length;
        emit('stats', Object.assign({}, stats));
        execute(task).then(
          (result) => settle(task, result),
          () => settle(task, { ok: false, url: task.url, error: 'internal', attempts: 1, bytes: 0, elapsedMs: 0 }),
        );
      }
    }

    function failure(target, url, error, extra) {
      return Object.assign(
        { ok: false, url, error, attempts: 0, bytes: 0, elapsedMs: 0, target },
        extra || {},
      );
    }

    return {
      stats() {
        return Object.assign({}, stats);
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      probe(rawUrl) {
        const target = normalizeTarget(rawUrl, base);
        if (!target) {
          return Promise.resolve(failure(rawUrl, String(rawUrl), 'invalid-target'));
        }
        const href = target.href;
        if (pending.has(href)) {
          stats.deduped += 1;
          emit('dedupe', { url: href });
          return pending.get(href);
        }
        if (sameOriginOnly && (target.protocol === 'http:' || target.protocol === 'https:') && origin && target.origin !== origin) {
          stats.blocked += 1;
          emit('blocked', { url: href });
          return Promise.resolve(failure(target, href, 'cross-origin-blocked'));
        }
        if (cache && cacheEnabled) {
          const hit = cache.get(href);
          if (hit) {
            stats.cacheHits += 1;
            emit('cache-hit', { url: href });
            return Promise.resolve({
              ok: true,
              url: href,
              durationMs: hit.durationMs,
              container: null,
              via: 'cache',
              bytes: 0,
              attempts: 0,
              elapsedMs: 0,
            });
          }
        }
        let resolver = null;
        const promise = new Promise((resolve) => {
          resolver = resolve;
        });
        const wrapped = promise.then((result) => {
          emit('result', result);
          return result;
        });
        pending.set(href, wrapped);
        waiting.push({ url: href, target: href, resolve: resolver });
        stats.queued = waiting.length;
        emit('queued', { url: href });
        pump();
        return wrapped;
      },
      purgePending() {
        const dropped = waiting.splice(0, waiting.length);
        stats.queued = 0;
        dropped.forEach((task) => {
          pending.delete(task.url);
          task.resolve({ ok: false, url: task.url, error: 'cancelled', attempts: 0, bytes: 0, elapsedMs: 0 });
        });
        emit('stats', Object.assign({}, stats));
        return dropped.length;
      },
      dispose() {
        disposed = true;
        const dropped = waiting.splice(0, waiting.length);
        dropped.forEach((task) => {
          pending.delete(task.url);
          task.resolve({ ok: false, url: task.url, error: 'cancelled', attempts: 0, bytes: 0, elapsedMs: 0 });
        });
        stats.queued = 0;
        listeners.clear();
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Diagnostics — runs in the browser and in the tests
   * ------------------------------------------------------------------ */

  async function runSelfTest(environment) {
    const env = environment || {};
    const results = [];
    const record = (name, pass, detail) => {
      results.push({ name, pass: Boolean(pass), detail: detail || '' });
    };
    async function check(name, fn) {
      try {
        const detail = await fn();
        record(name, detail !== false, typeof detail === 'string' ? detail : '');
      } catch (error) {
        record(name, false, error && error.message ? error.message : 'threw');
      }
    }

    await check('MP4 mvhd v0 parses', () => {
      const value = parseMp4Duration(buildMp4Fixture(95.5));
      return value !== null && Math.abs(value - 95500) < 2 ? `${Math.round(value)} ms` : false;
    });

    await check('MP4 mvhd v1 parses', () => {
      const value = parseMp4Duration(buildMp4Fixture(3600, { version: 1, timescale: 90000 }));
      return value !== null && Math.abs(value - 3600000) < 100 ? `${Math.round(value)} ms` : false;
    });

    await check('WebM Duration parses', () => {
      const value = parseWebmDuration(buildWebmFixture(42.25));
      return value !== null && Math.abs(value - 42250) < 2 ? `${Math.round(value)} ms` : false;
    });

    await check('WebM honours TimecodeScale', () => {
      const value = parseWebmDuration(buildWebmFixture(10, { timecodeScale: 100000 }));
      return value !== null && Math.abs(value - 10000) < 2 ? `${Math.round(value)} ms` : false;
    });

    await check('Unknown bytes yield no duration', () => durationFromBytes(buildCorruptFixture()) === null);

    await check('Duration formatting', () => {
      const cases = [
        [0, '0:00'],
        [9500, '0:09'],
        [95500, '1:35'],
        [3600000, '1:00:00'],
        [Number.NaN, ''],
      ];
      return cases.every((pair) => formatDuration(pair[0]) === pair[1]) ? '5 cases' : false;
    });

    await check('Byte formatting', () => {
      const cases = [
        [0, '0 B'],
        [512, '512 B'],
        [2048, '2.0 KB'],
        [5 * 1024 * 1024, '5.0 MB'],
      ];
      return cases.every((pair) => formatBytes(pair[0]) === pair[1]) ? '4 cases' : false;
    });

    await check('GPC forces the GHOST profile', () => {
      const policy = resolvePolicy('standard', { gpc: true });
      return policy.id === 'ghost' && policy.forcedByGpc && !policy.cacheEnabled;
    });

    await check('Cache round-trip', () => {
      const cache = createCache({ storage: fakeStorage(), prefix: 'selftest#', now: () => 1000 });
      cache.set('target', 5000);
      const hit = cache.get('target');
      return hit !== null && hit.durationMs === 5000 ? 'write + read' : false;
    });

    await check('Proxy queue completes a probe', async () => {
      const bytes = buildMp4Fixture(12);
      const engine = createEngine({
        fetch: () => Promise.resolve(new Response(bytes, { status: 206 })),
        retries: 0,
        retryBaseMs: 1,
        now: () => 0,
      });
      const result = await engine.probe('demo://mp4/12');
      engine.dispose();
      return result.ok && Math.abs(result.durationMs - 12000) < 2 ? '12 s via queue' : false;
    });

    return results;
  }

  /* ------------------------------------------------------------------ *
   * Browser-only helpers
   * ------------------------------------------------------------------ */

  function safeStorage() {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const probe = `${SETTINGS_PREFIX}probe`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    } catch (error) {
      return null;
    }
  }

  function fakeStorage() {
    const map = new Map();
    return {
      get length() {
        return map.size;
      },
      key(index) {
        return Array.from(map.keys())[index] === undefined ? null : Array.from(map.keys())[index];
      },
      getItem(key) {
        return map.has(key) ? map.get(key) : null;
      },
      setItem(key, value) {
        map.set(String(key), String(value));
      },
      removeItem(key) {
        map.delete(key);
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Terminal UI
   * ------------------------------------------------------------------ */

  function boot() {
    const doc = document;
    const byId = (id) => doc.getElementById(id);
    const nodes = {
      clock: byId('clock'),
      linkState: byId('link-state'),
      gpcBadge: byId('gpc-badge'),
      swState: byId('sw-state'),
      buildTag: byId('build-tag'),
      statQueued: byId('stat-queued'),
      statActive: byId('stat-active'),
      statOk: byId('stat-ok'),
      statFailed: byId('stat-failed'),
      statDeduped: byId('stat-deduped'),
      statBytes: byId('stat-bytes'),
      statHits: byId('stat-hits'),
      probeInput: byId('probe-input'),
      probeRun: byId('probe-run'),
      probeDemo: byId('probe-demo'),
      probeClear: byId('probe-clear'),
      probeRows: byId('probe-rows'),
      probeSummary: byId('probe-summary'),
      sameOrigin: byId('same-origin'),
      policyGrid: byId('policy-grid'),
      policyNote: byId('policy-note'),
      cacheCount: byId('cache-count'),
      cacheBytes: byId('cache-bytes'),
      cacheMode: byId('cache-mode'),
      cacheRows: byId('cache-rows'),
      cacheExport: byId('cache-export'),
      cachePurge: byId('cache-purge'),
      cacheRefresh: byId('cache-refresh'),
      testRun: byId('selftest-run'),
      testRows: byId('selftest-rows'),
      testSummary: byId('selftest-summary'),
      log: byId('console-log'),
      logClear: byId('console-clear'),
      usMeta: byId('userscript-meta'),
      usRefresh: byId('userscript-refresh'),
      usInstall: byId('userscript-install'),
      swUpdate: byId('sw-update'),
      swPurge: byId('sw-purge'),
      swUnregister: byId('sw-unregister'),
      toast: byId('toast'),
    };

    if (!nodes.probeInput || !nodes.probeRows) {
      return;
    }

    const state = {
      policy: null,
      cache: null,
      engine: null,
      rows: new Map(),
      log: [],
      worker: null,
      toastTimer: null,
      probeBusy: false,
    };

    /* ---------- small DOM utilities (no innerHTML anywhere) ---------- */

    function element(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) {
        node.className = className;
      }
      if (text !== undefined && text !== null) {
        node.textContent = String(text);
      }
      return node;
    }

    function cell(text, className) {
      const td = element('td', className || '', text);
      return td;
    }

    function setText(node, value) {
      if (node) {
        node.textContent = String(value);
      }
    }

    function toast(message) {
      if (!nodes.toast) {
        return;
      }
      nodes.toast.textContent = message;
      nodes.toast.classList.add('is-visible');
      if (state.toastTimer) {
        clearTimeout(state.toastTimer);
      }
      state.toastTimer = setTimeout(() => nodes.toast.classList.remove('is-visible'), 2600);
    }

    function redact(url) {
      if (state.policy && state.policy.logUrls) {
        return url;
      }
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.hostname === 'localhost' ? 'localhost' : '⟨redacted⟩'}/${parsed.pathname.split('/').filter(Boolean).length ? '…' : ''}`;
      } catch (error) {
        return '⟨redacted⟩';
      }
    }

    /* ---------- console stream ---------- */

    function log(kind, message) {
      const stamp = new Date().toISOString().slice(11, 19);
      state.log.push({ kind, message, stamp });
      if (state.log.length > LOG_LIMIT) {
        state.log.splice(0, state.log.length - LOG_LIMIT);
      }
      renderLog();
    }

    function renderLog() {
      if (!nodes.log) {
        return;
      }
      const fragment = doc.createDocumentFragment();
      state.log.slice(-60).forEach((entry) => {
        const line = element('li', `log-line log-${entry.kind}`);
        line.appendChild(element('span', 'log-stamp', entry.stamp));
        line.appendChild(element('span', 'log-message', entry.message));
        fragment.appendChild(line);
      });
      nodes.log.replaceChildren(fragment);
    }

    /* ---------- telemetry ---------- */

    function renderTelemetry() {
      const stats = state.engine
        ? state.engine.stats()
        : { queued: 0, active: 0, ok: 0, failed: 0, deduped: 0, bytes: 0, cacheHits: 0 };
      setText(nodes.statQueued, stats.queued);
      setText(nodes.statActive, stats.active);
      setText(nodes.statOk, stats.ok);
      setText(nodes.statFailed, stats.failed);
      setText(nodes.statDeduped, stats.deduped);
      setText(nodes.statBytes, formatBytes(stats.bytes));
      setText(nodes.statHits, stats.cacheHits);
      const busy = stats.active > 0 || stats.queued > 0;
      if (nodes.linkState) {
        nodes.linkState.dataset.state = busy ? 'busy' : 'idle';
      }
    }

    /* ---------- policy ---------- */

    function storedProfile() {
      const store = safeStorage();
      if (!store) {
        return 'standard';
      }
      try {
        const value = store.getItem(SETTINGS_PREFIX + PROFILE_KEY);
        return value || 'standard';
      } catch (error) {
        return 'standard';
      }
    }

    function persistProfile(id, policy) {
      const store = safeStorage();
      if (!store) {
        return;
      }
      try {
        if (policy.remember) {
          store.setItem(SETTINGS_PREFIX + PROFILE_KEY, id);
        } else {
          store.removeItem(SETTINGS_PREFIX + PROFILE_KEY);
        }
      } catch (error) {
        /* storage refused; the choice just will not survive a reload */
      }
    }

    function renderPolicy() {
      const policy = state.policy;
      doc.querySelectorAll('input[name="profile"]').forEach((input) => {
        input.checked = input.value === policy.id;
        input.disabled = policy.forcedByGpc && input.value !== 'ghost';
      });
      if (nodes.policyNote) {
        const parts = [`<${policy.label}> ${policy.note}`];
        if (policy.forcedByGpc) {
          parts.push('Global Privacy Control is on, so the GHOST profile is enforced.');
        }
        parts.push(policy.cacheEnabled ? `Cache TTL ${Math.round(policy.ttl / 3600000)} h.` : 'No cache writes.');
        setText(nodes.policyNote, parts.join(' '));
      }
      if (nodes.gpcBadge) {
        nodes.gpcBadge.textContent = policy.gpc ? 'GPC · ON' : 'GPC · OFF';
        nodes.gpcBadge.dataset.state = policy.gpc ? 'on' : 'off';
      }
    }

    function rebuildCache() {
      const policy = state.policy;
      const store = safeStorage();
      if (!policy.cacheEnabled) {
        const memoryOnly = createCache({ storage: null, ttl: 0, maxEntries: 0 });
        memoryOnly.purge();
        if (store) {
          const persistent = createCache({ storage: store, prefix: CACHE_PREFIX });
          persistent.purge();
        }
        state.cache = memoryOnly;
        return;
      }
      state.cache = createCache({
        storage: policy.id === 'ghost' ? null : store,
        prefix: CACHE_PREFIX,
        ttl: policy.ttl,
        maxEntries: policy.maxEntries,
      });
    }

    function fetchImpl(url, init) {
      if (typeof url === 'string' && url.startsWith('demo://')) {
        return demoResponse(url);
      }
      return window.fetch(url, init);
    }

    function demoResponse(url) {
      const match = /^demo:\/\/([a-z0-9-]+)\/([0-9.]+)$/i.exec(url);
      const kind = match ? match[1].toLowerCase() : 'corrupt';
      const seconds = match ? Number(match[2]) : 0;
      let bytes;
      let type;
      if (kind === 'mp4') {
        bytes = buildMp4Fixture(seconds);
        type = 'video/mp4';
      } else if (kind === 'webm') {
        bytes = buildWebmFixture(seconds);
        type = 'video/webm';
      } else {
        bytes = buildCorruptFixture();
        type = 'application/octet-stream';
      }
      return Promise.resolve(
        new Response(bytes, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'content-type': type,
            'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
          },
        }),
      );
    }

    function rebuildEngine() {
      if (state.engine) {
        state.engine.dispose();
      }
      state.engine = createEngine({
        fetch: fetchImpl,
        concurrency: 3,
        retries: 2,
        cache: state.cache,
        cacheEnabled: state.policy.cacheEnabled,
        sameOriginOnly: nodes.sameOrigin ? nodes.sameOrigin.checked : true,
        origin: location.origin,
        base: location.href,
      });
      state.engine.on((kind, detail) => {
        if (kind === 'stats') {
          renderTelemetry();
          return;
        }
        if (kind === 'retry' && detail) {
          log('warn', `retry ${redact(detail.url)} · attempt ${detail.attempt} (${detail.error})`);
        }
        if (kind === 'blocked' && detail) {
          log('warn', `blocked cross-origin probe ${redact(detail.url)}`);
        }
        if (kind === 'dedupe' && detail) {
          log('info', `collapsed duplicate probe ${redact(detail.url)}`);
        }
        if (kind === 'cache-hit' && detail) {
          log('info', `cache hit ${redact(detail.url)}`);
        }
      });
      renderTelemetry();
    }

    function applyPolicy(id, options) {
      const settings = options || {};
      state.policy = resolvePolicy(id, { gpc: detectGpc() });
      if (settings.persist !== false) {
        persistProfile(state.policy.id, state.policy);
      }
      rebuildCache();
      rebuildEngine();
      renderPolicy();
      renderCache();
      log('info', `profile → ${state.policy.id}${state.policy.forcedByGpc ? ' (GPC enforced)' : ''}`);
    }

    /* ---------- probe table ---------- */

    function clearRows() {
      state.rows.clear();
      nodes.probeRows.replaceChildren();
      setText(nodes.probeSummary, 'standing by · 0 targets');
    }

    function createRow(url) {
      if (state.rows.has(url)) {
        return state.rows.get(url);
      }
      const tr = element('tr', 'probe-row');
      const target = element('td', 'col-target');
      target.textContent = redact(url);
      target.title = state.policy && state.policy.logUrls ? url : 'target redacted by policy';
      const status = cell('QUEUED', 'col-status');
      status.dataset.state = 'queued';
      const duration = cell('—', 'col-duration');
      const bytes = cell('—', 'col-bytes');
      const attempts = cell('—', 'col-attempts');
      const elapsed = cell('—', 'col-elapsed');
      tr.append(target, status, duration, bytes, attempts, elapsed);
      const record = { tr, status, duration, bytes, attempts, elapsed };
      state.rows.set(url, record);
      nodes.probeRows.prepend(tr);
      while (nodes.probeRows.children.length > ROW_LIMIT) {
        nodes.probeRows.lastElementChild.remove();
      }
      return record;
    }

    const ERROR_LABELS = {
      'cross-origin-blocked': 'BLOCKED',
      'invalid-target': 'INVALID',
      'no-duration': 'NO METADATA',
      timeout: 'TIMEOUT',
      network: 'NETWORK',
      internal: 'INTERNAL',
      'http-403': 'HTTP 403',
      'http-404': 'HTTP 404',
      'http-416': 'HTTP 416',
    };

    function updateRow(url, result) {
      const record = state.rows.get(url);
      if (!record) {
        return;
      }
      record.status.textContent = result.ok ? (result.via === 'cache' ? 'CACHE' : 'OK') : ERROR_LABELS[result.error] || String(result.error).toUpperCase();
      record.status.dataset.state = result.ok ? (result.via === 'cache' ? 'cache' : 'ok') : 'fail';
      record.duration.textContent = result.ok ? formatDuration(result.durationMs) : '—';
      record.bytes.textContent = result.bytes ? formatBytes(result.bytes) : '—';
      record.attempts.textContent = String(result.attempts);
      record.elapsed.textContent = `${Math.round(result.elapsedMs)} ms`;
      if (result.ok) {
        log('ok', `${formatDuration(result.durationMs)} · ${result.container || 'cache'} · ${redact(url)}`);
      } else {
        log('fail', `${record.status.textContent} · ${redact(url)}`);
      }
    }

    function parseTargets(text) {
      return String(text || '')
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, PROBE_LIMIT);
    }

    async function runProbes() {
      if (state.probeBusy) {
        return;
      }
      const targets = parseTargets(nodes.probeInput.value);
      if (targets.length === 0) {
        toast('No targets in the queue');
        return;
      }
      state.probeBusy = true;
      nodes.probeRun.disabled = true;
      nodes.probeRun.dataset.state = 'busy';
      setText(nodes.probeSummary, `scanning ${targets.length} target(s) · concurrency 3`);
      targets.forEach((url) => createRow(url.startsWith('demo://') ? url : url));

      const started = performance.now();
      const results = await Promise.all(
        targets.map((url) => state.engine.probe(url).then((result) => {
          updateRow(url, result);
          return result;
        })),
      );

      const ok = results.filter((result) => result.ok).length;
      const cached = results.filter((result) => result.via === 'cache').length;
      const failed = results.length - ok;
      setText(
        nodes.probeSummary,
        `${ok} resolved (${cached} cached) · ${failed} failed · ${Math.round(performance.now() - started)} ms wall clock`,
      );
      state.probeBusy = false;
      nodes.probeRun.disabled = false;
      nodes.probeRun.dataset.state = 'idle';
      renderTelemetry();
      renderCache();
    }

    /* ---------- cache panel ---------- */

    function renderCache() {
      if (!state.cache) {
        return;
      }
      const stats = state.cache.stats();
      setText(nodes.cacheCount, stats.count);
      setText(nodes.cacheBytes, formatBytes(stats.bytes));
      setText(
        nodes.cacheMode,
        state.policy && state.policy.cacheEnabled
          ? `${state.policy.id.toUpperCase()} · TTL ${Math.round(state.policy.ttl / 3600000)} h · cap ${state.policy.maxEntries}`
          : 'DISABLED · memory only',
      );

      const entries = state.cache.entries().slice(0, 40);
      const fragment = doc.createDocumentFragment();
      if (entries.length === 0) {
        const tr = element('tr', 'empty-row');
        const td = element('td', '', 'cache empty');
        td.colSpan = 3;
        tr.appendChild(td);
        fragment.appendChild(tr);
      } else {
        entries.forEach((entry) => {
          const tr = element('tr');
          const key = element('td', 'col-target', redact(entry.key));
          key.title = state.policy && state.policy.logUrls ? entry.key : 'entry redacted by policy';
          tr.append(
            key,
            cell(formatDuration(entry.durationMs), 'col-duration'),
            cell(formatAge(Date.now() - entry.savedAt), 'col-age'),
          );
          fragment.appendChild(tr);
        });
      }
      nodes.cacheRows.replaceChildren(fragment);
    }

    /* ---------- diagnostics ---------- */

    function renderTests(results) {
      const fragment = doc.createDocumentFragment();
      results.forEach((result) => {
        const tr = element('tr', result.pass ? 'test-pass' : 'test-fail');
        const name = element('td', 'col-test', result.name);
        const verdict = element('td', 'col-verdict', result.pass ? 'PASS' : 'FAIL');
        const detail = element('td', 'col-detail', result.detail || '—');
        tr.append(name, verdict, detail);
        fragment.appendChild(tr);
      });
      nodes.testRows.replaceChildren(fragment);
      const passed = results.filter((result) => result.pass).length;
      setText(nodes.testSummary, `${passed}/${results.length} checks passed`);
      nodes.testSummary.dataset.state = passed === results.length ? 'ok' : 'fail';
    }

    async function runDiagnostics() {
      nodes.testRun.disabled = true;
      setText(nodes.testSummary, 'running…');
      const results = await runSelfTest();
      renderTests(results);
      const failed = results.filter((result) => !result.pass).length;
      log(failed ? 'fail' : 'ok', `diagnostics ${results.length - failed}/${results.length} passed`);
      nodes.testRun.disabled = false;
    }

    /* ---------- userscript panel ---------- */

    async function loadUserscript() {
      if (!nodes.usMeta) {
        return;
      }
      try {
        const response = await window.fetch('erome.user.js', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const source = await response.text();
        const block = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/.exec(source);
        const field = (name) => {
          if (!block) {
            return '—';
          }
          const match = new RegExp(`^// @${name}\\s+(.+)$`, 'm').exec(block[1]);
          return match ? match[1].trim() : '—';
        };
        nodes.usMeta.replaceChildren();
        const rows = [
          ['version', field('version')],
          ['name', field('name')],
          ['match', field('match')],
          ['description', field('description')],
          ['lines', String(source.split('\n').length)],
        ];
        rows.forEach((pair) => {
          const dt = element('dt', '', pair[0]);
          const dd = element('dd', '', pair[1]);
          nodes.usMeta.append(dt, dd);
        });
        if (nodes.usInstall) {
          const version = field('version');
          nodes.usInstall.href = 'erome.user.js';
          nodes.usInstall.dataset.version = version;
        }
        log('ok', `userscript v${field('version')} read from origin`);
      } catch (error) {
        nodes.usMeta.replaceChildren();
        nodes.usMeta.append(
          element('dt', '', 'status'),
          element('dd', 'is-error', 'unavailable — serve this page over HTTP(S), not from file://'),
        );
        log('fail', `userscript unavailable: ${error.message}`);
      }
    }

    /* ---------- service worker ---------- */

    function setWorkerState(label, stateName) {
      if (!nodes.swState) {
        return;
      }
      nodes.swState.textContent = label;
      nodes.swState.dataset.state = stateName;
    }

    function setupWorker() {
      if (!('serviceWorker' in navigator)) {
        setWorkerState('SW · UNSUPPORTED', 'off');
        return;
      }
      const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
      if (!secure) {
        setWorkerState('SW · INSECURE ORIGIN', 'off');
        log('warn', 'service worker needs https:// or localhost');
        return;
      }
      setWorkerState('SW · REGISTERING', 'busy');

      navigator.serviceWorker
        .register('sw.js', { scope: './' })
        .then((registration) => {
          state.worker = registration;
          setWorkerState(registration.active ? 'SW · ACTIVE' : 'SW · INSTALLING', 'busy');
          registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            if (!installing) {
              return;
            }
            installing.addEventListener('statechange', () => {
              if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                if (nodes.swUpdate) {
                  nodes.swUpdate.hidden = false;
                }
                log('info', 'shell update ready — reload to activate');
              }
            });
          });
          return navigator.serviceWorker.ready;
        })
        .then(() => {
          setWorkerState('SW · ACTIVE', 'on');
          askWorker({ type: 'STATS' });
        })
        .catch((error) => {
          setWorkerState('SW · FAILED', 'fail');
          log('fail', `service worker failed: ${error.message}`);
        });

      navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'STATS') {
          log('info', `shell cache: ${data.entries} entries · ${data.version}`);
        }
        if (data.type === 'PURGED') {
          log('ok', `caches purged (${data.removed} entries)`);
          toast('Caches purged');
        }
      });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        log('ok', 'new service worker in control');
      });
    }

    function askWorker(message) {
      const worker = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!worker) {
        return;
      }
      worker.postMessage(message);
    }

    /* ---------- clock + connectivity ---------- */

    function tickClock() {
      if (!nodes.clock) {
        return;
      }
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      const offset = -now.getTimezoneOffset() / 60;
      const zone = `UTC${offset >= 0 ? '+' : ''}${offset}`;
      setText(nodes.clock, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} · ${zone}`);
    }

    function renderConnectivity() {
      if (!nodes.linkState) {
        return;
      }
      const online = navigator.onLine !== false;
      nodes.linkState.dataset.online = online ? 'true' : 'false';
      if (!online) {
        setText(nodes.linkState, 'OFFLINE · SHELL ONLY');
      }
    }

    /* ---------- wiring ---------- */

    function wire() {
      doc.querySelectorAll('input[name="profile"]').forEach((input) => {
        input.addEventListener('change', () => {
          if (input.checked) {
            applyPolicy(input.value);
            toast(`Profile ${input.value.toUpperCase()} engaged`);
          }
        });
      });

      if (nodes.sameOrigin) {
        nodes.sameOrigin.addEventListener('change', () => {
          rebuildEngine();
          log('info', `same-origin lock ${nodes.sameOrigin.checked ? 'engaged' : 'released'}`);
        });
      }

      nodes.probeRun.addEventListener('click', runProbes);
      nodes.probeClear.addEventListener('click', () => {
        nodes.probeInput.value = '';
        clearRows();
        log('info', 'probe queue cleared');
      });
      if (nodes.probeDemo) {
        nodes.probeDemo.addEventListener('click', () => {
          nodes.probeInput.value = ['demo://mp4/95.5', 'demo://webm/42.25', 'demo://mp4/3600', 'demo://unknown/1'].join('\n');
          toast('Synthetic targets loaded — no network involved');
        });
      }
      nodes.probeInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          runProbes();
        }
      });

      nodes.cacheRefresh.addEventListener('click', renderCache);
      nodes.cachePurge.addEventListener('click', () => {
        const removed = state.cache ? state.cache.purge() : 0;
        renderCache();
        log('ok', `purged ${removed} cache entr${removed === 1 ? 'y' : 'ies'}`);
        toast(`Purged ${removed} entries`);
      });
      nodes.cacheExport.addEventListener('click', () => {
        if (!state.cache) {
          return;
        }
        const blob = new Blob([state.cache.exportJson()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = element('a');
        anchor.href = url;
        anchor.download = `gridcore-cache-${new Date().toISOString().slice(0, 10)}.json`;
        doc.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        log('ok', 'cache exported');
      });

      nodes.testRun.addEventListener('click', runDiagnostics);
      nodes.logClear.addEventListener('click', () => {
        state.log.length = 0;
        renderLog();
      });

      if (nodes.usRefresh) {
        nodes.usRefresh.addEventListener('click', loadUserscript);
      }

      if (nodes.swUpdate) {
        nodes.swUpdate.addEventListener('click', () => {
          askWorker({ type: 'SKIP_WAITING' });
          setTimeout(() => location.reload(), 250);
        });
      }
      if (nodes.swPurge) {
        nodes.swPurge.addEventListener('click', () => askWorker({ type: 'PURGE' }));
      }
      if (nodes.swUnregister) {
        nodes.swUnregister.addEventListener('click', async () => {
          if (!('serviceWorker' in navigator)) {
            return;
          }
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
          setWorkerState('SW · REMOVED', 'off');
          log('warn', 'service worker unregistered for this origin');
        });
      }

      doc.addEventListener('keydown', (event) => {
        const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
        const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
        if (event.key === '/' && !typing) {
          event.preventDefault();
          nodes.probeInput.focus();
        }
        if (event.key === 'Escape' && document.activeElement === nodes.probeInput) {
          nodes.probeInput.blur();
        }
      });

      window.addEventListener('online', () => {
        renderConnectivity();
        log('ok', 'network back online');
      });
      window.addEventListener('offline', () => {
        renderConnectivity();
        log('warn', 'network offline — cached shell still serves');
      });
    }

    /* ---------- boot sequence ---------- */

    setText(nodes.buildTag, `v${HUD_VERSION}`);
    tickClock();
    setInterval(tickClock, 1000);
    renderConnectivity();
    applyPolicy(storedProfile(), { persist: false });
    wire();
    loadUserscript();
    setupWorker();
    setText(nodes.probeSummary, 'standing by · 0 targets');
    log('info', `GRID//CORE v${HUD_VERSION} online`);
    log('info', `policy ${state.policy.id} · cache ${state.policy.cacheEnabled ? 'on' : 'off'} · origin ${location.origin}`);
  }

  /* ------------------------------------------------------------------ *
   * Export surface
   * ------------------------------------------------------------------ */

  const api = {
    HUD_VERSION,
    MAX_HEAD_BYTES,
    MAX_TAIL_BYTES,
    PROFILES,
    CACHE_PREFIX,
    SETTINGS_PREFIX,
    formatDuration,
    formatBytes,
    formatAge,
    parseMp4Duration,
    parseWebmDuration,
    sniffContainer,
    durationFromBytes,
    buildMp4Fixture,
    buildWebmFixture,
    buildCorruptFixture,
    createCache,
    createEngine,
    resolvePolicy,
    detectGpc,
    normalizeTarget,
    classifyStatus,
    runSelfTest,
    fakeStorage,
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
    console.warn('[gridcore]', error);
  }
}());
