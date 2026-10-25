// ==UserScript==
// @name         erome.com video length
// @namespace    https://github.com/drdre1/
// @icon         https://www.erome.com/favicon.ico
// @version      1.2
// @description  Duration of video on erome.com + continuous clip registration, Dogecoin HUD & Eightfold payloads
// @author       drdre1
// @match        https://www.erome.com/*
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================================================
  // BRAND
  // --------------------------------------------------------------------------
  // Every storage key, DOM marker attribute, CSS class and window global this
  // script creates is derived from this ONE constant. That keeps all of the
  // moving parts under a single namespace so they can be found, audited and
  // torn down together.
  //
  // NOTE: the UserScript @namespace / @name above are deliberately unchanged.
  // Userscript managers identify an installed script by namespace+name, so
  // rebranding them would silently fork every existing install into a second
  // copy. The brand below governs our own state, not the manager's identity.
  // ==========================================================================
  const BRAND = 'erome-clip-registry';
  const VERSION = '1.2';
  const NS = BRAND + ':';        // localStorage key prefix  -> "<BRAND>:<table>#<key>"
  const ATTR = 'data-' + BRAND;  // DOM marker: "this node belongs to us"
  const CSS = BRAND;             // CSS class prefix
  const GLOBAL = 'EroClipRegistry';
  const DEFAULT_PERSONA = 'Much4K';
  const CURRENCY = 'USD';        // local settlement metadata slot strictly USD-only

  // v1.0 cached durations under this prefix. Migrated once into the registry,
  // then removed, so exactly one record per clip ever exists.
  const LEGACY_PREFIX = '$vl#';

  const MAX_RECORDS = 2000;          // registry cap; least-recently-seen evicted first
  const PRUNE_EVERY = 25;            // re-check the cap every N registrations
  const HEALTH_INTERVAL_MS = 2000;   // re-attach the observer if its root is detached
  const FOUR_K_MIN_PIXELS = 8000000; // 3840x2160 = 8.29M, DCI 4096x2160 = 8.85M

  // Candidates we look for. DOM-only: we never fetch, paginate or crawl.
  const SELECTOR = 'video';

  // Path segments on erome.com that look like a username but never are.
  const RESERVED_PATHS = new Set([
    'a', 'i', 'v', 'u', 'p', 'me', 'home', 'index', 'login', 'logout', 'signup',
    'register', 'signin', 'signout', 'trending', 'new', 'news', 'search', 'api',
    'faq', 'terms', 'privacy', 'dmca', '2257', 'contact', 'blog', 'tag', 'tags',
    'category', 'categories', 'model', 'models', 'video', 'videos', 'image',
    'images', 'album', 'albums', 'user', 'users', 'setting', 'settings',
    'account', 'message', 'messages', 'notification', 'notifications', 'upload',
    'popular', 'random', 'sitemap', 'help', 'about', 'status', 'feed', 'explore',
    'discover', 'collection', 'collections', 'gallery', 'galleries', 'media',
    'playlist', 'playlists', 'profile', 'profiles', 'inbox', 'friends',
    'following', 'followers', 'subscriptions', 'history', 'watch', 'download',
    'downloads', 'report', 'reports', 'feedback', 'forum', 'forums', 'community',
    'shop', 'store', 'premium', 'vip', 'gold', 'billing', 'payment', 'payments',
    'pay', 'checkout', 'cart', 'order', 'orders', 'subscribe', 'unsubscribe',
    'verify', 'verification', 'reset', 'password', 'forgot', 'confirm',
    'activate', 'activation', 'invite', 'invites', 'referral', 'referrals',
    'stats', 'statistics', 'dashboard', 'admin', 'moderator', 'mod', 'staff',
    'team', 'jobs', 'careers', 'press', 'ads', 'advertising', 'partner',
    'partners', 'affiliate', 'affiliates', 'content', 'contents', 'static',
    'assets', 'asset', 'img', 'css', 'js', 'fonts', 'font', 'favicon.ico',
    'robots.txt', 'health', 'live', 'cam', 'cams', 'top', 'most-viewed'
  ]);

  // --------------------------------------------------------------------------
  // small helpers
  // --------------------------------------------------------------------------
  function toInt(value) {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /** First argument that carries real information; 0 and null both count as unknown. */
  function firstKnown() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (v !== null && v !== undefined && v !== 0 && v !== '') return v;
    }
    return null;
  }

  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function extFromUrl(url) {
    const m = url.split(/[?#]/)[0].match(/\.([A-Za-z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : null;
  }

  function formatDuration(milliseconds) {
    let s = milliseconds / 1000;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s = Math.floor(s - m * 60);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return (h > 0 ? h + ':' : '') + mm + ':' + ss;
  }

  function slug(text) {
    return str(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  function b64uEncode(text) {
    const utf8 = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
    return window.btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64uDecode(token) {
    let b64 = str(token).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = window.atob(b64);
    let pct = '';
    for (let i = 0; i < bin.length; i++) {
      pct += '%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2);
    }
    return decodeURIComponent(pct);
  }

  // ==========================================================================
  // STORE
  // --------------------------------------------------------------------------
  // A small table-oriented persistence layer, in the spirit of a relational
  // store: fixed tables ("clips", "movies", "users", "meta"), one keyed record
  // per row, and a single canonical schema written by normalizePayload().
  // Backed by localStorage, degrading to an in-memory Map when storage is
  // unavailable (private mode) or full (quota exceeded).
  // ==========================================================================
  const Store = (function () {
    let usable = false;
    try {
      const probe = NS + '@probe';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      usable = true;
    } catch (err) {
      usable = false;
    }

    const memory = new Map();
    let live = usable ? 'localStorage' : 'memory';

    function fullKey(table, key) {
      return NS + table + '#' + key;
    }

    function readRaw(k) {
      if (memory.has(k)) return memory.get(k);
      if (usable) {
        try { return window.localStorage.getItem(k); } catch (e) { live = 'memory'; }
      }
      return null;
    }

    function writeRaw(k, v) {
      if (usable) {
        try {
          window.localStorage.setItem(k, v);
          memory.delete(k);
          live = 'localStorage';
          return true;
        } catch (e) {
          /* quota exceeded — keep serving this session from memory */
          live = 'memory';
        }
      }
      memory.set(k, v);
      return false;
    }

    function removeRaw(k) {
      if (usable) {
        try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      }
      memory.delete(k);
    }

    function scanKeys(table) {
      const prefix = NS + table + '#';
      const out = [];
      if (usable) {
        try {
          const ls = window.localStorage;
          for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && k.indexOf(prefix) === 0) out.push(k);
          }
        } catch (e) { /* ignore */ }
      }
      memory.forEach(function (v, k) {
        if (k.indexOf(prefix) === 0 && out.indexOf(k) === -1) out.push(k);
      });
      return out;
    }

    function keyOf(fullK, table) {
      return fullK.slice(NS.length + table.length + 1);
    }

    return {
      usable: usable,
      mode: function () { return live; },

      get: function (table, key) {
        const full = fullKey(table, key);
        const raw = readRaw(full);
        if (raw === null || raw === undefined) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          removeRaw(full); // corrupt row — drop it rather than poison every read
          return null;
        }
      },

      set: function (table, key, record) {
        return writeRaw(fullKey(table, key), JSON.stringify(record));
      },

      has: function (table, key) {
        return readRaw(fullKey(table, key)) !== null;
      },

      del: function (table, key) {
        removeRaw(fullKey(table, key));
      },

      all: function (table) {
        const out = {};
        scanKeys(table).forEach(function (k) {
          const raw = readRaw(k);
          if (raw === null) return;
          try {
            out[keyOf(k, table)] = JSON.parse(raw);
          } catch (e) {
            removeRaw(k);
          }
        });
        return out;
      },

      count: function (table) {
        return scanKeys(table).length;
      },

      clearTable: function (table) {
        scanKeys(table).forEach(removeRaw);
      },

      meta: function (key, value) {
        const full = fullKey('meta', key);
        if (arguments.length < 2) return readRaw(full);
        writeRaw(full, String(value));
      }
    };
  }());

  // ==========================================================================
  // LEGACY MIGRATION — "clone it once properly"
  // --------------------------------------------------------------------------
  // v1.0 stored bare durations as "$vl#<url>" -> "<ms>". Copy each one into a
  // full clip record exactly once, then delete the legacy key so there is a
  // single source of truth per clip.
  // ==========================================================================
  function migrateLegacyDurations() {
    if (Store.meta('legacyMigrated') === '1') return 0;

    const legacyKeys = [];
    try {
      const ls = window.localStorage;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.indexOf(LEGACY_PREFIX) === 0) legacyKeys.push(k);
      }
    } catch (e) {
      Store.meta('legacyMigrated', '1');
      return 0;
    }

    let moved = 0;
    legacyKeys.forEach(function (k) {
      let raw = null;
      try { raw = window.localStorage.getItem(k); } catch (e) { return; }

      const url = k.slice(LEGACY_PREFIX.length);
      const ms = toInt(raw);
      if (!url || ms === null || ms < 0) return;

      const id = hash(url);
      const existing = Store.get('clips', id);
      const now = Date.now();
      const rec = normalizePayload({
        url: url,
        durationMs: ms,
        albumId: existing ? existing.albumId : null,
        albumTitle: existing ? existing.albumTitle : null,
        username: existing ? existing.username : null,
        width: existing ? existing.width : null,
        height: existing ? existing.height : null,
        registeredAt: existing ? existing.registeredAt : now,
        seenCount: existing ? existing.seenCount : 0,
        source: 'migration'
      });
      Store.set('clips', id, rec);

      try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      moved++;
    });

    Store.meta('legacyMigrated', '1');
    Store.meta('migratedAt', String(Date.now()));
    return moved;
  }

  // ==========================================================================
  // PAYLOAD STRUCTURE
  // --------------------------------------------------------------------------
  // "handle the payload structure all the time": no matter where a clip's data
  // came from (DOM attributes, media metadata, the legacy cache, or the WebM
  // header probe), it is normalized into this one canonical record shape before
  // it is ever written. Nothing downstream has to guess at a field's type.
  // ==========================================================================
  function normalizePayload(input) {
    const rec = input || {};
    const url = str(rec.url);
    const width = toInt(rec.width);
    const height = toInt(rec.height);
    const durationMs = toInt(rec.durationMs);
    const now = Date.now();

    const hasDuration = durationMs !== null && durationMs >= 0;
    const w = width !== null && width > 0 ? width : null;
    const h = height !== null && height > 0 ? height : null;

    return {
      id: hash(url),
      url: url,
      ext: extFromUrl(url),

      durationMs: hasDuration ? durationMs : null,
      durationLabel: hasDuration ? formatDuration(durationMs) : null,

      width: w,
      height: h,
      pixels: w && h ? w * h : null,
      is4k: !!(w && h && (w * h) >= FOUR_K_MIN_PIXELS),

      albumId: str(rec.albumId) || null,
      albumTitle: str(rec.albumTitle) || null,
      username: str(rec.username) || null,
      index: toInt(rec.index),

      registeredAt: toInt(rec.registeredAt) || now,
      lastSeen: now,
      seenCount: (toInt(rec.seenCount) || 0) + 1,
      source: str(rec.source) || 'dom'
    };
  }

  // ==========================================================================
  // DOM READING
  // ==========================================================================
  function resolveSrc(el) {
    if (!el) return '';
    const attr = el.getAttribute ? el.getAttribute('src') : null;
    // An explicit empty src="" reflects as document.baseURI on el.src per the
    // HTML spec, which would otherwise register the album page URL as a clip.
    if (attr !== null && str(attr) === '') return '';
    const raw = str(attr) || str(el.currentSrc) || str(el.src);
    if (!raw) return '';
    if (/^(blob:|data:|javascript:)/i.test(raw)) return '';
    try {
      return new URL(raw, document.baseURI).href;
    } catch (e) {
      return raw;
    }
  }

  function usernameFromEl(el) {
    if (!el || !el.getAttribute) return null;

    const explicit = el.getAttribute('data-username') || el.getAttribute('data-user');
    if (explicit && /^[A-Za-z0-9_.\-]{2,40}$/.test(explicit)) return explicit;

    const href = el.getAttribute('href');
    if (!href) return null;

    // Profile links on erome are bare "/<username>"; album/media links are
    // "/a/<id>", "/i/<id>", "/v/<id>" — RESERVED_PATHS rejects those.
    // Strip query/hash first: the "only videos" toggle rewrites a.hash on every
    // anchor in the page, which would otherwise invalidate real profile links.
    const path = str(href).split(/[?#]/)[0];
    const m = path.match(/^(?:https?:\/\/(?:www\.)?erome\.com)?\/([^/?#]+)\/?$/i);
    if (!m) return null;

    const name = m[1];
    if (RESERVED_PATHS.has(name.toLowerCase())) return null;
    if (!/^[A-Za-z0-9_.\-]{2,40}$/.test(name)) return null;

    // Require the visible text to agree with the slug; navigation links
    // ("Home", "Trending", ...) otherwise leak through as fake usernames.
    const text = str(el.textContent);
    if (text && text.toLowerCase().indexOf(name.toLowerCase()) === -1) return null;

    return name;
  }

  function findUsername(root) {
    const scope = root || document;
    const preferred = [
      '.user a[href]',
      '.username a[href]',
      'a.username[href]',
      '.uploader a[href]',
      '.user-info a[href]',
      '.author a[href]',
      '.album-header a[href]',
      '.album-title a[href]',
      '[data-username]'
    ];

    for (let i = 0; i < preferred.length; i++) {
      let matches;
      try { matches = scope.querySelectorAll(preferred[i]); } catch (e) { continue; }
      for (let j = 0; j < matches.length; j++) {
        const name = usernameFromEl(matches[j]);
        if (name) return name;
      }
    }

    // Fallback: any profile-shaped anchor outside the media grid.
    const anchors = scope.querySelectorAll('a[href]');
    for (let k = 0; k < anchors.length; k++) {
      const a = anchors[k];
      if (a.closest && a.closest('.media-group, .video, .player, .img')) continue;
      const name = usernameFromEl(a);
      if (name) return name;
    }
    return null;
  }

  function albumContext(el) {
    let albumId = null;
    let albumTitle = null;
    let username = null;

    const albumEl = el && el.closest ? el.closest('.album') : null;
    if (albumEl) {
      const link = albumEl.querySelector('a[href*="/a/"]');
      if (link) {
        const m = str(link.getAttribute('href')).match(/\/a\/([^/?#]+)/);
        if (m) albumId = m[1];
      }
      const titleEl = albumEl.querySelector('.album-title, .title, h1, h2, h3');
      if (titleEl) albumTitle = str(titleEl.textContent);
      username = findUsername(albumEl);
    }

    if (!albumId) {
      const m = document.location.pathname.match(/^\/a\/([^/?#]+)/);
      if (m) albumId = m[1];
    }
    if (!albumTitle) {
      const h = document.querySelector('h1');
      if (h) albumTitle = str(h.textContent);
    }
    if (!username) username = findUsername(document);
    if (!albumId && albumTitle) albumId = slug(albumTitle);

    return { albumId: albumId, albumTitle: albumTitle, username: username };
  }

  function mediaIndex(videoEl) {
    if (!videoEl || !videoEl.closest) return null;
    const group = videoEl.closest('.media-group');
    const scope = videoEl.closest('.album') || (group && group.parentNode) || group;
    if (!scope || !scope.querySelectorAll) return null;
    const items = scope.querySelectorAll('.media-group .video, .media-group .img');
    const list = items.length ? items : (group ? group.querySelectorAll('.video, .img') : []);
    for (let i = 0; i < list.length; i++) {
      if (list[i].contains(videoEl)) return i;
    }
    return null;
  }

  /** Everything the DOM already knows about this element, no network involved. */
  function readDomPayload(sourceEl, videoEl, url) {
    const ctx = albumContext(videoEl || sourceEl);
    let width = null;
    let height = null;
    let durationMs = null;

    if (videoEl) {
      if (videoEl.videoWidth > 0) width = videoEl.videoWidth;
      if (videoEl.videoHeight > 0) height = videoEl.videoHeight;
      if (isFinite(videoEl.duration) && videoEl.duration > 0) {
        durationMs = Math.round(videoEl.duration * 1000);
      }
      const dw = toInt(videoEl.getAttribute('width'));
      const dh = toInt(videoEl.getAttribute('height'));
      width = firstKnown(width, dw);
      height = firstKnown(height, dh);
    }

    return normalizePayload({
      url: url,
      width: width,
      height: height,
      durationMs: durationMs,
      albumId: ctx.albumId,
      albumTitle: ctx.albumTitle,
      username: ctx.username,
      index: mediaIndex(videoEl || sourceEl),
      source: durationMs !== null ? 'metadata' : 'dom'
    });
  }

  // ==========================================================================
  // WRITE PATH — clips -> movies -> users
  // ==========================================================================
  function recordClip(payload) {
    const rec = normalizePayload(payload);
    if (!rec.url) return null;

    const prev = Store.get('clips', rec.id);
    if (prev) {
      // Merge, never clobber: a later pass may see the element before its
      // metadata has loaded, and must not erase what an earlier pass learned.
      rec.registeredAt = toInt(prev.registeredAt) || rec.registeredAt;
      rec.seenCount = (toInt(prev.seenCount) || 0) + 1;
      rec.durationMs = firstKnown(rec.durationMs, prev.durationMs);
      rec.durationLabel = rec.durationMs !== null ? formatDuration(rec.durationMs) : null;
      rec.width = firstKnown(rec.width, prev.width);
      rec.height = firstKnown(rec.height, prev.height);
      rec.pixels = rec.width && rec.height ? rec.width * rec.height : null;
      rec.is4k = !!(rec.pixels && rec.pixels >= FOUR_K_MIN_PIXELS);
      rec.albumId = firstKnown(rec.albumId, prev.albumId);
      rec.albumTitle = firstKnown(rec.albumTitle, prev.albumTitle);
      rec.username = firstKnown(rec.username, prev.username);
      // index is zero-based, so 0 is a real position — firstKnown() treats 0 as
      // unknown and would erase the first clip of every media group.
      rec.index = rec.index !== null && rec.index !== undefined ? rec.index : prev.index;
      rec.ext = firstKnown(rec.ext, prev.ext);
    }

    Store.set('clips', rec.id, rec);
    if (rec.albumId) touchMovie(rec);
    if (rec.username) touchUser(rec);
    refreshHud();
    return rec;
  }

  /** An album is the "movie": the ordered set of clips registered under it. */
  function touchMovie(rec) {
    const key = rec.albumId;
    const prev = Store.get('movies', key);
    const movie = prev || {
      albumId: key,
      title: null,
      username: null,
      clipIds: [],
      clipCount: 0,
      totalDurationMs: 0,
      fourKCount: 0,
      has4k: false,
      createdAt: Date.now(),
      updatedAt: 0
    };

    movie.title = firstKnown(rec.albumTitle, movie.title);
    movie.username = firstKnown(rec.username, movie.username);
    if (movie.clipIds.indexOf(rec.id) === -1) movie.clipIds.push(rec.id);
    if (toInt(rec.index) !== null) {
      movie.clipIds.sort(function (a, b) {
        const ca = Store.get('clips', a);
        const cb = Store.get('clips', b);
        return (ca && toInt(ca.index) !== null ? toInt(ca.index) : 0) -
               (cb && toInt(cb.index) !== null ? toInt(cb.index) : 0);
      });
    }

    let total = 0;
    let fourK = 0;
    movie.clipIds.forEach(function (id) {
      const c = Store.get('clips', id);
      if (!c) return;
      if (toInt(c.durationMs) !== null) total += toInt(c.durationMs);
      if (c.is4k) fourK++;
    });

    movie.clipCount = movie.clipIds.length;
    movie.totalDurationMs = total;
    movie.totalDurationLabel = total ? formatDuration(total) : null;
    movie.fourKCount = fourK;
    movie.has4k = fourK > 0;
    movie.updatedAt = Date.now();

    Store.set('movies', key, movie);
    return movie;
  }

  /** Usernames are tracked across albums for the whole life of the registry. */
  function touchUser(rec) {
    const key = rec.username;
    const prev = Store.get('users', key);
    const user = prev || {
      username: key,
      clipIds: [],
      clipCount: 0,
      albumIds: [],
      albumCount: 0,
      fourKCount: 0,
      totalDurationMs: 0,
      firstSeen: Date.now(),
      lastSeen: 0
    };

    if (user.clipIds.indexOf(rec.id) === -1) user.clipIds.push(rec.id);
    if (rec.albumId && user.albumIds.indexOf(rec.albumId) === -1) user.albumIds.push(rec.albumId);

    let total = 0;
    let fourK = 0;
    user.clipIds.forEach(function (id) {
      const c = Store.get('clips', id);
      if (!c) return;
      if (toInt(c.durationMs) !== null) total += toInt(c.durationMs);
      if (c.is4k) fourK++;
    });

    user.clipCount = user.clipIds.length;
    user.albumCount = user.albumIds.length;
    user.totalDurationMs = total;
    user.fourKCount = fourK;
    user.firstSeen = toInt(user.firstSeen) || Date.now();
    user.lastSeen = Date.now();

    Store.set('users', key, user);
    return user;
  }

  // ==========================================================================
  // DOGECOIN PERSONALIZATION + USD SETTLEMENT METADATA + EIGHTFOLD CODEC
  // --------------------------------------------------------------------------
  // - Dogecoin personalized badge/theme (no live payment transfers).
  // - Local settlement schema slot strictly enforces USD ("USD ONLY").
  // - Deterministic 8-fold ("eightfold") canonical envelope with djb2 checksum.
  // ==========================================================================
  function getPersona() {
    const raw = Store.meta('personaTag');
    const tag = str(raw) || DEFAULT_PERSONA;
    return {
      symbol: '\u00D0',
      theme: 'dogecoin-gold',
      tag: tag
    };
  }

  function setPersona(nextTag) {
    const clean = str(String(nextTag === undefined || nextTag === null ? '' : nextTag))
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 32) || DEFAULT_PERSONA;
    Store.meta('personaTag', clean);
    document.querySelectorAll('[' + ATTR + '="doge-tag"]').forEach(function (el) {
      el.textContent = '\u00D0 ' + clean;
      el.title = 'Personalized Dogecoin badge: ' + clean;
    });
    triggerAngularForce();
    refreshHud();
    return getPersona();
  }

  function getSettlement() {
    const cents = Math.max(0, toInt(Store.meta('usdCents')) || 0);
    return {
      currency: CURRENCY,
      amountCents: cents,
      amountUsd: (cents / 100).toFixed(2),
      mode: 'metadata-only'
    };
  }

  function setSettlementUsd(currencyOrAmount, maybeAmount) {
    let curr = CURRENCY;
    let val = currencyOrAmount;
    if (arguments.length >= 2 || (typeof currencyOrAmount === 'string' && /^[A-Za-z]{3,6}$/.test(str(currencyOrAmount)))) {
      curr = str(currencyOrAmount).toUpperCase();
      val = maybeAmount;
    }
    if (curr !== CURRENCY) {
      throw new Error('USD ONLY: settlement metadata rejects non-USD currency "' + curr + '"');
    }
    const num = Number(val);
    if (!isFinite(num) || num < 0) {
      throw new Error('Invalid USD amount');
    }
    const cents = Math.round(num * 100);
    Store.meta('usdCents', String(cents));
    refreshHud();
    return getSettlement();
  }

  function buildEightfold(clipOrUrl) {
    let rec = null;
    if (typeof clipOrUrl === 'string') {
      rec = Store.get('clips', hash(clipOrUrl)) || normalizePayload({ url: clipOrUrl });
    } else if (clipOrUrl && typeof clipOrUrl === 'object') {
      rec = clipOrUrl.id && clipOrUrl.url ? clipOrUrl : normalizePayload(clipOrUrl);
    }
    if (!rec || !rec.url) return null;

    const f1 = { brand: BRAND, version: VERSION, id: rec.id, url: rec.url, ext: rec.ext };
    const f2 = {
      durationMs: rec.durationMs,
      durationLabel: rec.durationLabel,
      width: rec.width,
      height: rec.height,
      pixels: rec.pixels,
      is4k: !!rec.is4k
    };
    const f3 = { albumId: rec.albumId, albumTitle: rec.albumTitle, index: rec.index };
    const f4 = { username: rec.username };
    const f5 = {
      registeredAt: rec.registeredAt,
      lastSeen: rec.lastSeen,
      seenCount: rec.seenCount,
      source: rec.source
    };
    const f6 = getPersona();
    const f7 = getSettlement();
    const checksum = hash(JSON.stringify([f1, f2, f3, f4, f5, f6, f7]));
    const f8 = { folds: 8, checksum: checksum, encodedAt: Date.now() };

    return {
      identity: f1,
      media: f2,
      movie: f3,
      creator: f4,
      lifecycle: f5,
      persona: f6,
      settlement: f7,
      integrity: f8
    };
  }

  function encodeEightfold(clipOrUrl) {
    const env = buildEightfold(clipOrUrl);
    if (!env) return null;
    const token = 'ecr8.' + b64uEncode(JSON.stringify(env)) + '.' + env.integrity.checksum;
    return { token: token, checksum: env.integrity.checksum, envelope: env };
  }

  function decodeEightfold(token) {
    const raw = str(token);
    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== 'ecr8') {
      return { valid: false, error: 'Malformed ecr8 token', envelope: null };
    }
    let env = null;
    try {
      env = JSON.parse(b64uDecode(parts[1]));
    } catch (e) {
      return { valid: false, error: 'Invalid base64url JSON payload', envelope: null };
    }
    if (!env || !env.integrity || env.integrity.folds !== 8) {
      return { valid: false, error: 'Envelope does not contain 8 folds', envelope: null };
    }
    if (!env.settlement || env.settlement.currency !== CURRENCY) {
      return { valid: false, error: 'USD ONLY violation in settlement fold', envelope: null };
    }
    const expected = hash(JSON.stringify([
      env.identity,
      env.media,
      env.movie,
      env.creator,
      env.lifecycle,
      env.persona,
      env.settlement
    ]));
    if (expected !== parts[2] || expected !== env.integrity.checksum) {
      return { valid: false, error: 'Eightfold checksum mismatch', envelope: null };
    }
    return { valid: true, error: null, envelope: env };
  }

  // ==========================================================================
  // DECORATION + ANGULAR FORCE + IN-PAGE DOGECOIN HUD
  // ==========================================================================
  function injectStyles() {
    if (document.querySelector('style[' + ATTR + ']')) return;
    const style = document.createElement('style');
    style.setAttribute(ATTR, 'style');
    style.textContent =
      '@keyframes ' + CSS + '-torque{' +
      '0%{transform:rotate(0deg) scale(1)}' +
      '45%{transform:rotate(195deg) scale(1.14)}' +
      '100%{transform:rotate(360deg) scale(1)}' +
      '}' +
      '.' + CSS + '-badge{' +
      'display:inline-block;margin-left:6px;padding:0 7px;' +
      'clip-path:polygon(5px 0,100% 0,calc(100% - 5px) 100%,0 100%);' +
      'font:700 11px/17px system-ui,sans-serif;vertical-align:middle;' +
      'background:#14120b;color:#f5c518;border:1px solid #c2a633;' +
      'transition:transform .28s cubic-bezier(.22,1,.36,1);' +
      '}' +
      '.' + CSS + '-badge:hover{transform:skewX(-8deg) scale(1.06);}' +
      '.' + CSS + '-badge-4k{background:linear-gradient(135deg,#f5c518,#c2a633);color:#14120b;}' +
      '.' + CSS + '-doge-tag{' +
      'display:inline-block;margin-left:6px;padding:0 7px;' +
      'clip-path:polygon(5px 0,100% 0,calc(100% - 5px) 100%,0 100%);' +
      'font:600 10px/16px ui-monospace,monospace;vertical-align:middle;' +
      'background:#1b170c;color:#e8cf6a;border:1px solid #8c7320;' +
      '}' +
      '.' + CSS + '-emblem{' +
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:22px;height:22px;border-radius:50%;font:800 13px/1 system-ui,sans-serif;' +
      'background:radial-gradient(circle at 30% 30%,#ffe270,#c2a633 70%,#7d6614);' +
      'color:#14120b;box-shadow:0 0 8px rgba(245,197,24,.45);cursor:pointer;' +
      '}' +
      '.' + CSS + '-spin{animation:' + CSS + '-torque .62s cubic-bezier(.22,1,.36,1);}' +
      '.' + CSS + '-link{display:block;overflow:hidden;text-overflow:ellipsis;' +
      'white-space:nowrap;font:11px/1.4 ui-monospace,monospace;opacity:.65;}' +
      '.' + CSS + '-hud{' +
      'position:fixed;right:10px;bottom:10px;z-index:99999;min-width:215px;' +
      'background:rgba(20,18,11,.94);color:#f3e6b3;border:1px solid #c2a633;' +
      'clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);' +
      'padding:8px 10px;font:11px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.55);' +
      '}' +
      '.' + CSS + '-hud-head{display:flex;align-items:center;gap:7px;justify-content:space-between;}' +
      '.' + CSS + '-hud-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:7px 0;text-align:center;}' +
      '.' + CSS + '-hud-cell{background:#211c10;padding:3px 4px;border:1px solid #4a3d16;}' +
      '.' + CSS + '-hud-val{display:block;font:700 12px/1.2 ui-monospace,monospace;color:#f5c518;}' +
      '.' + CSS + '-hud-row{display:flex;gap:4px;margin-top:5px;}' +
      '.' + CSS + '-hud-btn{' +
      'flex:1;background:#262011;color:#f5c518;border:1px solid #8c7320;padding:2px 5px;' +
      'font:600 10px/1.4 system-ui,sans-serif;cursor:pointer;' +
      '}' +
      '.' + CSS + '-hud-input{' +
      'flex:1;min-width:0;background:#120f08;color:#ffe270;border:1px solid #6b5718;' +
      'padding:2px 5px;font:11px/1.3 ui-monospace,monospace;' +
      '}';
    (document.head || document.documentElement).appendChild(style);
  }

  let torqueCount = 0;

  function triggerAngularForce() {
    torqueCount++;
    const nodes = document.querySelectorAll('.' + CSS + '-emblem, [' + ATTR + '="badge"]');
    nodes.forEach(function (el) {
      el.classList.remove(CSS + '-spin');
      // Retrigger keyframe cleanly without layout thrash when unavailable
      if (el.offsetWidth) { /* reflow */ }
      el.classList.add(CSS + '-spin');
    });
    return torqueCount;
  }

  /** Direct child of `parent` carrying our marker with this exact value. */
  function brandChild(parent, value) {
    if (!parent || !parent.children) return null;
    for (let i = 0; i < parent.children.length; i++) {
      const c = parent.children[i];
      if (c.getAttribute && c.getAttribute(ATTR) === value) return c;
    }
    return null;
  }

  function ensureAnchor(sourceEl, videoEl, url, prevUrl) {
    const player = videoEl && videoEl.parentNode;
    const holder = player && player.parentNode;
    if (!holder || typeof holder.insertBefore !== 'function') return null;

    const a = brandChild(holder, 'link');
    if (a) {
      if (prevUrl && a.href === prevUrl && prevUrl !== url) {
        a.href = url;
        a.textContent = url;
      }
      return a;
    }
    return createAnchor(holder, player, url);
  }

  function createAnchor(holder, player, url) {
    const a = document.createElement('a');
    a.setAttribute(ATTR, 'link');
    a.className = CSS + '-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.appendChild(document.createTextNode(url));
    try {
      holder.insertBefore(a, player);
    } catch (e) {
      holder.appendChild(a);
    }
    return a;
  }

  /**
   * The label and badge live in ONE brand-marked container placed immediately
   * after the anchor. The first cut of v1.1 looked them up as *children* of the
   * anchor while inserting them as *siblings* (insertAdjacentElement), so the
   * lookup never matched and every repaint minted a duplicate. Searching the
   * container's own children is what makes repaints idempotent.
   */
  function ensureMeta(anchor) {
    let node = anchor.nextElementSibling;
    while (node) {
      if (node.nodeType === 1 && node.getAttribute) {
        const mark = node.getAttribute(ATTR);
        if (mark === 'meta') return node;
        if (mark === 'link') break; // reached the next clip's anchor
      }
      node = node.nextElementSibling;
    }
    const meta = document.createElement('span');
    meta.setAttribute(ATTR, 'meta');
    anchor.insertAdjacentElement('afterend', meta);
    return meta;
  }

  function decorate(anchor, rec) {
    if (!anchor || !anchor.parentNode || !rec) return;
    const meta = ensureMeta(anchor);

    let label = brandChild(meta, 'length');
    if (!label) {
      label = document.createElement('span');
      label.setAttribute(ATTR, 'length');
      meta.appendChild(label);
    }
    label.textContent = rec.durationLabel ? ' ' + rec.durationLabel : '';

    let badge = brandChild(meta, 'badge');
    if (rec.is4k) {
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(ATTR, 'badge');
        badge.className = CSS + '-badge ' + CSS + '-badge-4k';
        badge.textContent = '4K';
        meta.appendChild(badge);
      }
      badge.title = rec.width + 'x' + rec.height;
    } else if (badge) {
      badge.remove(); // resolution was provisional and turned out not to be 4K
    }

    let doge = brandChild(meta, 'doge-tag');
    const persona = getPersona();
    if (!doge) {
      doge = document.createElement('span');
      doge.setAttribute(ATTR, 'doge-tag');
      doge.className = CSS + '-doge-tag';
      meta.appendChild(doge);
    }
    doge.textContent = '\u00D0 ' + persona.tag;
    doge.title = 'Personalized Dogecoin badge: ' + persona.tag;
  }

  let hudCollapsed = false;

  function ensureHud() {
    if (!document.body) return null;
    let hud = document.querySelector('aside[' + ATTR + '="hud"]');
    if (hud && document.body.contains(hud)) return hud;

    hud = document.createElement('aside');
    hud.setAttribute(ATTR, 'hud');
    hud.className = CSS + '-hud';

    const head = document.createElement('div');
    head.setAttribute(ATTR, 'hud-head');
    head.className = CSS + '-hud-head';

    const left = document.createElement('div');
    left.setAttribute(ATTR, 'hud-brand');
    left.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const emblem = document.createElement('span');
    emblem.setAttribute(ATTR, 'hud-emblem');
    emblem.className = CSS + '-emblem';
    emblem.textContent = '\u00D0';
    emblem.title = 'Trigger Angular Force spin';
    emblem.addEventListener('click', function () {
      triggerAngularForce();
    });

    const title = document.createElement('strong');
    title.setAttribute(ATTR, 'hud-persona');
    title.style.color = '#ffe270';

    left.appendChild(emblem);
    left.appendChild(title);

    const statePill = document.createElement('button');
    statePill.setAttribute(ATTR, 'hud-toggle');
    statePill.type = 'button';
    statePill.className = CSS + '-hud-btn';
    statePill.style.flex = '0 0 auto';
    statePill.addEventListener('click', function () {
      hudCollapsed = !hudCollapsed;
      refreshHud();
    });

    head.appendChild(left);
    head.appendChild(statePill);
    hud.appendChild(head);

    const body = document.createElement('div');
    body.setAttribute(ATTR, 'hud-body');

    const grid = document.createElement('div');
    grid.setAttribute(ATTR, 'hud-grid');
    grid.className = CSS + '-hud-grid';
    [
      ['clips', 'Clips'],
      ['movies', 'Movies'],
      ['users', 'Users'],
      ['fourk', '4K']
    ].forEach(function (pair) {
      const cell = document.createElement('div');
      cell.setAttribute(ATTR, 'hud-cell-' + pair[0]);
      cell.className = CSS + '-hud-cell';
      const val = document.createElement('span');
      val.setAttribute(ATTR, 'hud-val-' + pair[0]);
      val.className = CSS + '-hud-val';
      val.textContent = '0';
      const cap = document.createElement('span');
      cap.textContent = pair[1];
      cell.appendChild(val);
      cell.appendChild(cap);
      grid.appendChild(cell);
    });
    body.appendChild(grid);

    const personaRow = document.createElement('div');
    personaRow.className = CSS + '-hud-row';
    const input = document.createElement('input');
    input.setAttribute(ATTR, 'persona-input');
    input.className = CSS + '-hud-input';
    input.type = 'text';
    input.maxLength = 32;
    input.placeholder = 'Dogecoin tag';
    input.value = getPersona().tag;
    const applyBtn = document.createElement('button');
    applyBtn.setAttribute(ATTR, 'persona-save');
    applyBtn.type = 'button';
    applyBtn.className = CSS + '-hud-btn';
    applyBtn.style.flex = '0 0 auto';
    applyBtn.textContent = 'Tag';
    applyBtn.addEventListener('click', function () {
      setPersona(input.value);
    });
    personaRow.appendChild(input);
    personaRow.appendChild(applyBtn);
    body.appendChild(personaRow);

    const ctrlRow = document.createElement('div');
    ctrlRow.className = CSS + '-hud-row';
    const pauseBtn = document.createElement('button');
    pauseBtn.setAttribute(ATTR, 'hud-pause');
    pauseBtn.type = 'button';
    pauseBtn.className = CSS + '-hud-btn';
    pauseBtn.addEventListener('click', function () {
      const st = Registry.status();
      if (!st.active) Registry.start();
      else if (st.paused) Registry.resume();
      else Registry.pause();
    });

    const scanBtn = document.createElement('button');
    scanBtn.setAttribute(ATTR, 'hud-rescan');
    scanBtn.type = 'button';
    scanBtn.className = CSS + '-hud-btn';
    scanBtn.textContent = 'Scan';
    scanBtn.addEventListener('click', function () {
      Registry.rescan();
      triggerAngularForce();
      refreshHud();
    });

    const spinBtn = document.createElement('button');
    spinBtn.setAttribute(ATTR, 'hud-spin');
    spinBtn.type = 'button';
    spinBtn.className = CSS + '-hud-btn';
    spinBtn.textContent = 'Force';
    spinBtn.addEventListener('click', function () {
      triggerAngularForce();
    });

    ctrlRow.appendChild(pauseBtn);
    ctrlRow.appendChild(scanBtn);
    ctrlRow.appendChild(spinBtn);
    body.appendChild(ctrlRow);

    const foot = document.createElement('div');
    foot.setAttribute(ATTR, 'hud-foot');
    foot.style.cssText = 'margin-top:5px;font:10px/1.3 ui-monospace,monospace;opacity:.8;display:flex;justify-content:space-between;';
    body.appendChild(foot);

    hud.appendChild(body);
    document.body.appendChild(hud);
    return hud;
  }

  function refreshHud() {
    if (typeof Registry === 'undefined' || !Registry || !document.body) return;
    const hud = ensureHud();
    if (!hud) return;

    const st = Registry.status();
    const persona = getPersona();
    const settle = getSettlement();
    const clipsMap = Store.all('clips');
    let fourKTotal = 0;
    Object.keys(clipsMap).forEach(function (k) {
      if (clipsMap[k] && clipsMap[k].is4k) fourKTotal++;
    });

    const setTxt = function (mark, txt) {
      const el = hud.querySelector('[' + ATTR + '="' + mark + '"]');
      if (el && el.textContent !== txt) el.textContent = txt;
    };

    setTxt('hud-persona', '\u00D0 ' + persona.tag);
    const stateLabel = !st.active ? 'STOP' : (st.paused ? 'PAUSED' : 'LIVE');
    setTxt('hud-toggle', hudCollapsed ? stateLabel + ' +' : stateLabel + ' -');
    setTxt('hud-val-clips', String(st.counts.clips));
    setTxt('hud-val-movies', String(st.counts.movies));
    setTxt('hud-val-users', String(st.counts.users));
    setTxt('hud-val-fourk', String(fourKTotal));
    setTxt('hud-pause', !st.active ? 'Start' : (st.paused ? 'Resume' : 'Pause'));
    setTxt('hud-foot', '8-Fold | ' + settle.currency + ' $' + settle.amountUsd);

    const body = hud.querySelector('[' + ATTR + '="hud-body"]');
    if (body) body.style.display = hudCollapsed ? 'none' : '';
    const input = hud.querySelector('[' + ATTR + '="persona-input"]');
    if (input && document.activeElement !== input && input.value !== persona.tag) {
      input.value = persona.tag;
    }
  }

  /** Keeps the min-length slider filter working, exactly as v1.0 did. */
  function syncSlider(videoEl, rec) {
    if (!videoEl || !rec || toInt(rec.durationMs) === null) return;
    const s = Math.floor(rec.durationMs / 1000);
    videoEl.dataset.length = s;
    const slider = document.getElementById('slider_min_length');
    if (slider) slider.max = Math.max(parseInt(slider.max, 10) || 0, s);
  }

  // ==========================================================================
  // DURATION PROBE (last resort)
  // --------------------------------------------------------------------------
  // The only network call in the script, carried over from v1.0: read the first
  // 140 bytes of the WebM and pull the duration out of the header. It runs ONLY
  // when the browser has not exposed duration via media metadata and we have no
  // cached value. Resolution is never probed — it comes from the element.
  // ==========================================================================
  const inFlight = new Set();

  function probeDuration(url, onResult) {
    if (inFlight.has(url)) return;
    if (typeof GM === 'undefined' || typeof GM.xmlHttpRequest !== 'function') return;

    inFlight.add(url);
    let settled = false;
    const finish = function (ms) {
      if (settled) return;
      settled = true;
      inFlight.delete(url);
      onResult(ms);
    };

    const req = GM.xmlHttpRequest({
      url: url,
      method: 'GET',
      headers: {
        Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        Referer: 'https://www.erome.com/',
        Range: 'bytes=0-140'
      },
      responseType: 'blob',
      onprogress: function (response) {
        if (Math.max(response.loaded, response.total) > 150) {
          try { req.abort(); } catch (e) { /* already done */ }
        }
      },
      onload: function (response) {
        const text = response.responseText || '';
        const m = text.match(/\x03.*\xe8/);
        if (!m) return finish(null);
        const i = text.indexOf(m[0]) + m[0].length;
        const s = text.substring(i, i + 4);
        const ms = Array.from(s)
          .map(function (c) { return c.charCodeAt(0); })
          .map(function (value, index, values) { return value * Math.pow(256, values.length - index - 1); })
          .reduce(function (a, b) { return a + b; }, 0);
        finish(ms > 0 ? ms : null);
      },
      onerror: function () { finish(null); },
      ontimeout: function () { finish(null); }
    });
  }

  // ==========================================================================
  // REGISTRY — continuous registration with full MutationObserver control
  // ==========================================================================
  const Registry = (function () {
    // Element+URL dedupe: each media node is registered once per URL per page
    // life, so re-observing the same subtree never produces a duplicate row,
    // while a real src swap on an existing element is picked up cleanly.
    const registered = new WeakMap();
    const metadataState = new WeakMap();

    const queued = new Set();   // nodes waiting for the next animation frame
    const dropped = { count: 0 }; // "unused work": nodes discarded before render

    let observer = null;
    let observedRoot = null;
    let frame = 0;
    let active = false;
    let paused = false;
    let sincePrune = 0;
    let stats = { scanned: 0, registered: 0, probed: 0, mutations: 0, flushes: 0, reattaches: 0 };
    let startedAt = 0;
    let healthTimer = 0;

    function scheduleFlush() {
      if (frame || !active || paused) return;
      frame = window.requestAnimationFrame(flush);
    }

    function candidatesFrom(node) {
      const out = [];
      const seen = new Set();

      function push(keyEl, videoEl, url) {
        if (!url || seen.has(keyEl)) return;
        seen.add(keyEl);
        out.push({ keyEl: keyEl, videoEl: videoEl, url: url });
      }

      function consider(v) {
        if (!v || v.tagName !== 'VIDEO') return;
        const sources = v.querySelectorAll('source');
        if (sources.length) {
          sources.forEach(function (s) { push(s, v, resolveSrc(s)); });
        } else {
          push(v, v, resolveSrc(v));
        }
      }

      if (!node || node.nodeType !== 1) return out;
      if (node.tagName === 'VIDEO') consider(node);
      else if (node.tagName === 'SOURCE' && node.parentNode && node.parentNode.tagName === 'VIDEO') consider(node.parentNode);
      if (node.querySelectorAll) node.querySelectorAll(SELECTOR).forEach(consider);
      return out;
    }

    function bindMetadata(cand, onChange) {
      const v = cand.videoEl;
      if (!v) return;
      const alreadyBound = metadataState.has(v);
      metadataState.set(v, { keyEl: cand.keyEl, paint: onChange });

      const handler = function () {
        const state = metadataState.get(v);
        if (!state) return;
        const currentUrl = resolveSrc(state.keyEl) || resolveSrc(v) || cand.url;
        const payload = readDomPayload(state.keyEl, v, currentUrl);
        const rec = recordClip(payload);
        syncSlider(v, rec);
        if (rec) state.paint(rec);
      };

      if (!alreadyBound) {
        ['loadedmetadata', 'resize', 'durationchange'].forEach(function (evt) {
          v.addEventListener(evt, handler, { passive: true });
        });
      }
      // If the metadata is already there, take it now instead of waiting.
      if (v.readyState >= 1) handler();
    }

    function registerCandidate(cand) {
      stats.scanned++;
      const prevUrl = registered.get(cand.keyEl) || null;
      if (prevUrl === cand.url) return false;
      registered.set(cand.keyEl, cand.url);

      ensureSlider();
      const anchor = ensureAnchor(cand.keyEl, cand.videoEl, cand.url, prevUrl);
      const initial = readDomPayload(cand.keyEl, cand.videoEl, cand.url);
      let rec = recordClip(initial);

      const paint = function (next) {
        if (next) rec = next;
        decorate(anchor, rec);
        syncSlider(cand.videoEl, rec);
      };
      paint(rec);

      bindMetadata(cand, paint);

      // Only reach for the network when nothing else can tell us the duration.
      if (rec && rec.durationMs === null) {
        stats.probed++;
        probeDuration(cand.url, function (ms) {
          if (ms === null) return;
          const stored = Store.get('clips', rec.id);
          const merged = recordClip(Object.assign({}, stored || rec, {
            durationMs: ms,
            source: 'webm-header'
          }));
          paint(merged);
        });
      }

      stats.registered++;
      sincePrune++;
      if (sincePrune >= PRUNE_EVERY) {
        sincePrune = 0;
        prune();
      }
      return true;
    }

    function scanNode(node) {
      candidatesFrom(node).forEach(registerCandidate);
    }

    function flush() {
      frame = 0;
      if (!active) { queued.clear(); return; }
      stats.flushes++;

      const nodes = Array.from(queued);
      queued.clear();

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node || node.nodeType !== 1) continue;
        // Unused work: the node was torn down again before we ever got to it.
        if (!document.contains(node)) { dropped.count++; continue; }
        scanNode(node);
      }

      // The observed root can be replaced wholesale by client-side rendering;
      // re-attach so registration truly never stops.
      if (observer && observedRoot && !document.contains(observedRoot)) reattach();
      refreshHud();
    }

    function isOurs(node) {
      if (!node || node.nodeType !== 1) return false;
      if (typeof node.hasAttribute === 'function' && node.hasAttribute(ATTR)) return true;
      if (typeof node.closest === 'function' && node.closest('[' + ATTR + ']')) return true;
      return false;
    }

    function onMutations(records) {
      if (!active || paused) return;
      for (let i = 0; i < records.length; i++) {
        const m = records[i];
        const target = m.target;
        if (isOurs(target)) continue; // our own decoration / HUD — ignore, or we would loop forever

        stats.mutations++;

        if (m.type === 'attributes') {
          if (target && target.nodeType === 1) queued.add(target);
          continue;
        }

        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (node.nodeType !== 1) continue;
          if (isOurs(node)) continue; // ours
          queued.add(node);
        }
      }
      if (queued.size) scheduleFlush();
    }

    function attach() {
      // Prefer documentElement: it survives a wholesale <body> replacement, so
      // client-side rendering that swaps the body cannot orphan the observer.
      const root = document.documentElement || document.body;
      if (!root) return false;
      observedRoot = root;
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
      return true;
    }

    function reattach() {
      if (!observer) return false;
      try { observer.disconnect(); } catch (e) { /* ignore */ }
      observedRoot = null;
      const ok = attach();
      if (ok) stats.reattaches++;
      return ok;
    }

    function isHealthy() {
      return !!(observer && observedRoot && document.contains(observedRoot));
    }

    /**
     * Recovery that does NOT depend on mutation flow. If the observed root is
     * detached, no mutation can ever fire on it again, so flush() would never
     * run and the re-attach inside it would never be reached — registration
     * would silently stop forever. This timer is the backstop for that case.
     * Cleared in stop(), so it never outlives the registry.
     */
    function healthCheck() {
      if (!active || !observer) return;
      if (!isHealthy()) {
        reattach();
        rescan(document); // pick up anything that arrived while we were blind
      }
    }

    function onPageHide() {
      // Full teardown: no observer, no pending frame, no queued work left behind.
      stop();
    }

    function start() {
      if (active) return true;
      injectStyles();
      observer = new MutationObserver(onMutations);
      active = true;
      paused = false;
      startedAt = Date.now();
      const ok = attach();
      window.addEventListener('pagehide', onPageHide, { passive: true });
      if (!healthTimer) healthTimer = window.setInterval(healthCheck, HEALTH_INTERVAL_MS);
      rescan(document);
      refreshHud();
      return ok;
    }

    function stop() {
      active = false;
      paused = false;
      if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
      if (healthTimer) { window.clearInterval(healthTimer); healthTimer = 0; }
      queued.clear();
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        observer = null;
      }
      observedRoot = null;
      window.removeEventListener('pagehide', onPageHide);
      refreshHud();
    }

    function pause() {
      if (!active) return;
      paused = true;
      if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
      queued.clear();
      refreshHud();
    }

    function resume() {
      if (!active) return start();
      paused = false;
      rescan(document);
      refreshHud();
    }

    function rescan(root) {
      const scope = root || document;
      if (scope.querySelectorAll) scope.querySelectorAll(SELECTOR).forEach(function (v) { scanNode(v); });
      if (scope.tagName === 'VIDEO') scanNode(scope);
    }

    /** Drop rows past the cap, then reap movies/users left with no clips. */
    function prune() {
      const clips = Store.all('clips');
      const ids = Object.keys(clips);
      if (ids.length > MAX_RECORDS) {
        ids.sort(function (a, b) {
          return (toInt(clips[a].lastSeen) || 0) - (toInt(clips[b].lastSeen) || 0);
        });
        ids.slice(0, ids.length - MAX_RECORDS).forEach(function (id) {
          Store.del('clips', id);
        });
      }

      ['movies', 'users'].forEach(function (table) {
        const rows = Store.all(table);
        Object.keys(rows).forEach(function (key) {
          const row = rows[key];
          const live = (row.clipIds || []).filter(function (id) { return Store.has('clips', id); });
          if (!live.length) {
            Store.del(table, key); // orphaned aggregate — unused work, reclaimed
            return;
          }
          if (live.length !== row.clipIds.length) {
            row.clipIds = live;
            row.clipCount = live.length;
            let total = 0;
            let fourK = 0;
            const albums = [];
            live.forEach(function (id) {
              const c = Store.get('clips', id);
              if (!c) return;
              if (toInt(c.durationMs) !== null) total += toInt(c.durationMs);
              if (c.is4k) fourK++;
              if (c.albumId && albums.indexOf(c.albumId) === -1) albums.push(c.albumId);
            });
            row.totalDurationMs = total;
            row.fourKCount = fourK;
            if (table === 'movies') {
              row.totalDurationLabel = total ? formatDuration(total) : null;
              row.has4k = fourK > 0;
              row.updatedAt = Date.now();
            } else {
              row.albumIds = albums;
              row.albumCount = albums.length;
            }
            Store.set(table, key, row);
          }
        });
      });
      refreshHud();
    }

    function status() {
      return {
        brand: BRAND,
        version: VERSION,
        active: active,
        paused: paused,
        observing: isHealthy(),
        healthTimer: !!healthTimer,
        observedRoot: observedRoot ? observedRoot.nodeName : null,
        uptimeMs: startedAt && active ? Date.now() - startedAt : 0,
        queued: queued.size,
        droppedNodes: dropped.count,
        torquePulses: torqueCount,
        persona: getPersona(),
        settlement: getSettlement(),
        storage: Store.mode(),
        counts: {
          clips: Store.count('clips'),
          movies: Store.count('movies'),
          users: Store.count('users')
        },
        stats: Object.assign({}, stats)
      };
    }

    return {
      start: start,
      stop: stop,
      pause: pause,
      resume: resume,
      rescan: rescan,
      reattach: reattach,
      healthCheck: healthCheck,
      prune: prune,
      status: status,
      _scanNode: scanNode
    };
  }());

  // ==========================================================================
  // GENESIS DECLARATIVE LANGUAGE STACK
  // --------------------------------------------------------------------------
  // Deterministic, zero-eval command runner over EroClipRegistry tables,
  // observer controls, Dogecoin personalization, USD-only settlement metadata,
  // and Eightfold payload encoding.
  // ==========================================================================
  function runGenesis(program) {
    const rawLines = String(program === undefined || program === null ? '' : program)
      .split(/[\r\n;]+/);
    const steps = [];
    let lastResult = null;
    let allOk = true;

    for (let i = 0; i < rawLines.length; i++) {
      const line = str(rawLines[i]);
      if (!line || line.indexOf('#') === 0 || line.indexOf('--') === 0) continue;

      const tokens = line.split(/\s+/);
      const op = tokens[0].toUpperCase();
      const rest = str(line.slice(tokens[0].length));

      try {
        if (op === 'START') {
          lastResult = Registry.start();
        } else if (op === 'STOP') {
          Registry.stop();
          lastResult = Registry.status();
        } else if (op === 'PAUSE') {
          Registry.pause();
          lastResult = Registry.status();
        } else if (op === 'RESUME') {
          Registry.resume();
          lastResult = Registry.status();
        } else if (op === 'SCAN' || op === 'RESCAN') {
          Registry.rescan();
          lastResult = Registry.status().counts;
        } else if (op === 'PRUNE') {
          Registry.prune();
          lastResult = Registry.status().counts;
        } else if (op === 'FORCE' || op === 'SPIN') {
          lastResult = { torquePulses: triggerAngularForce() };
        } else if (op === 'PERSONA') {
          lastResult = setPersona(rest);
        } else if (op === 'USD') {
          lastResult = setSettlementUsd(CURRENCY, rest || '0');
        } else if (op === 'SETTLE') {
          const cur = tokens[1] || '';
          const amt = tokens[2] !== undefined ? tokens[2] : '0';
          lastResult = setSettlementUsd(cur, amt);
        } else if (op === 'SELECT') {
          const table = (tokens[1] || 'clips').toLowerCase();
          if (table !== 'clips' && table !== 'movies' && table !== 'users') {
            throw new Error('Unknown table "' + table + '" (expected clips, movies, or users)');
          }
          let rows = Object.values(Store.all(table));
          const whereIdx = tokens.map(function (t) { return t.toUpperCase(); }).indexOf('WHERE');
          if (whereIdx !== -1) {
            const conds = tokens.slice(whereIdx + 1);
            conds.forEach(function (cond) {
              const lc = cond.toLowerCase();
              if (lc === '4k' || lc === 'is4k=true') {
                rows = rows.filter(function (r) { return !!(r.is4k || r.has4k || r.fourKCount > 0); });
              } else if (lc.indexOf('user=') === 0) {
                const u = cond.slice(5);
                rows = rows.filter(function (r) { return r.username === u; });
              } else if (lc.indexOf('movie=') === 0) {
                const m = cond.slice(6);
                rows = rows.filter(function (r) { return r.albumId === m; });
              } else if (lc.indexOf('minsec=') === 0) {
                const msMin = (Number(cond.slice(7)) || 0) * 1000;
                rows = rows.filter(function (r) {
                  const d = r.durationMs !== undefined ? r.durationMs : r.totalDurationMs;
                  return (toInt(d) || 0) >= msMin;
                });
              }
            });
          }
          lastResult = rows;
        } else if (op === 'ENCODE') {
          const arg = str(rest);
          if (!arg || arg.toUpperCase() === 'ALL') {
            lastResult = Object.values(Store.all('clips')).map(encodeEightfold).filter(Boolean);
          } else {
            const single = encodeEightfold(arg);
            if (!single) throw new Error('Unable to encode "' + arg + '"');
            lastResult = single;
          }
        } else {
          throw new Error('Unknown Genesis op "' + op + '"');
        }
        steps.push({ line: line, op: op, ok: true, output: lastResult });
      } catch (err) {
        allOk = false;
        const msg = err && err.message ? err.message : String(err);
        steps.push({ line: line, op: op, ok: false, error: msg });
        lastResult = null;
      }
    }

    return {
      ok: allOk,
      brand: BRAND,
      version: VERSION,
      steps: steps,
      result: lastResult
    };
  }

  // ==========================================================================
  // PUBLIC CONTROL SURFACE
  // --------------------------------------------------------------------------
  // One branded global with full control over the observer and the registry.
  // ==========================================================================
  window[GLOBAL] = {
    brand: BRAND,
    version: VERSION,

    start: Registry.start,
    stop: Registry.stop,
    pause: Registry.pause,
    resume: Registry.resume,
    rescan: Registry.rescan,
    reattach: Registry.reattach,
    healthCheck: Registry.healthCheck,
    status: Registry.status,

    clips: function () { return Store.all('clips'); },
    movies: function () { return Store.all('movies'); },
    users: function () { return Store.all('users'); },
    clip: function (url) { return Store.get('clips', hash(url)); },

    persona: getPersona,
    personalize: setPersona,
    settlement: getSettlement,
    setUsd: setSettlementUsd,
    angularForce: triggerAngularForce,

    eightfold: buildEightfold,
    encodeEightfold: encodeEightfold,
    decodeEightfold: decodeEightfold,
    genesis: runGenesis,

    export: function () {
      const clips = Store.all('clips');
      return JSON.stringify({
        brand: BRAND,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        persona: getPersona(),
        settlement: getSettlement(),
        clips: clips,
        movies: Store.all('movies'),
        users: Store.all('users'),
        eightfold: Object.keys(clips).map(function (id) { return encodeEightfold(clips[id]); }).filter(Boolean)
      }, null, 2);
    },

    clear: function (table) {
      if (table) { Store.clearTable(table); refreshHud(); return; }
      ['clips', 'movies', 'users'].forEach(Store.clearTable);
      refreshHud();
    },

    prune: Registry.prune,
    store: Store
  };

  // ==========================================================================
  // MINIMUM-LENGTH SLIDER (v1.0 behaviour, preserved)
  // ==========================================================================
  function showSlider() {
    const div = document.createElement('div');
    div.setAttribute(ATTR, 'slider');
    div.setAttribute('style', 'position:fixed; right:0px; top:50px');
    div.innerHTML = 'Minimal length:<br>';
    const output = div.appendChild(document.createElement('output'));
    output.setAttribute('id', 'slider_min_length_output');
    const slider = div.appendChild(document.createElement('input'));
    slider.setAttribute('id', 'slider_min_length');
    slider.setAttribute('type', 'range');
    slider.setAttribute('step', '1');
    slider.setAttribute('min', '1');
    let maxS = 5;
    document.querySelectorAll('video').forEach((v) => {
      const len = parseInt(v.dataset && v.dataset.length, 10);
      if (!isNaN(len) && len > maxS) maxS = len;
    });
    slider.setAttribute('max', String(maxS));
    slider.setAttribute('value', '1');
    document.body.appendChild(div);
    slider.addEventListener('input', () => {
      const minS = parseInt(slider.value);
      if (minS > 1) {
        const m = parseInt(slider.value / 60);
        const s = minS - m * 60;
        output.textContent = `${m}:${s > 9 ? s : (`0${s}`)}`;
        document.querySelectorAll('.video')
          .forEach((vc) => {
            const video = vc.querySelector('.player video');
            if (video && 'length' in video.dataset && video.dataset.length < minS) {
              vc.style.display = 'none';
            } else {
              vc.style.display = '';
            }
          });
      } else {
        output.textContent = 'Off';
        document.querySelectorAll('.video')
          .forEach((vc) => {
            vc.style.display = '';
          });
      }
    });
  };

  // ==========================================================================
  // "ONLY VIDEOS" FILTER (v1.0 behaviour, preserved)
  // ==========================================================================
  let minNumberOfVideos = 0;

  const showOnlyVideosThumbs = function () {
    document.querySelectorAll('.album')
      .forEach((album) => {
        const e = album.querySelector('.album-videos');
        if (e && e.textContent && parseInt(e.textContent) && parseInt(e.textContent) >= minNumberOfVideos) {
          return;
        }
        album.style.display = 'none';
      });
  };

  const showOnlyVideosAlbum = function () {
    document.querySelectorAll('.media-group')
      .forEach((mediaGroup) => {
        if (!mediaGroup.querySelector('.video')) {
          mediaGroup.remove();
        }
      });
  };

  const showOnlyVideos = function (ev) {
    if (ev) {
      ev.preventDefault();
    }
    minNumberOfVideos++;
    if (document.location.hash.match(/onlyvideos=(\d+)/)) {
      document.location.hash = document.location.hash.replace(/onlyvideos=\d+/, `onlyvideos=${minNumberOfVideos}`);
    } else {
      document.location.hash = `#onlyvideos=${minNumberOfVideos}`;
    }
    if (document.location.pathname.startsWith('/a/')) {
      showOnlyVideosAlbum();
    } else {
      showOnlyVideosThumbs();
    }
    document.querySelectorAll('a[href]')
      .forEach((a) => {
        a.hash = `#onlyvideos=${minNumberOfVideos}`;
      });
  };

  const disableShowOnlyVideos = function (ev) {
    if (ev) {
      ev.preventDefault();
    }
    document.location.hash = '';
    document.location.reload();
  };

  function ensureSlider() {
    if (!document.body || document.getElementById('slider_min_length')) return;
    if (document.querySelectorAll('video').length > 1) {
      showSlider();
    }
  }

  // ==========================================================================
  // BOOT
  // ==========================================================================
  ensureSlider();

  const migrated = migrateLegacyDurations();
  if (migrated) Store.meta('migratedCount', String(migrated));

  Registry.start();

  if (document.querySelector('#app-navbar-collapse ul.navbar-right')) {
    const a = document.querySelector('#app-navbar-collapse ul.navbar-right')
      .appendChild(document.createElement('li'))
      .appendChild(document.createElement('a'));
    a.setAttribute(ATTR, 'nav');
    a.href = `#onlyvideos=${minNumberOfVideos + 1}`;
    a.title = 'Right click to disable';
    a.addEventListener('click', showOnlyVideos);
    a.addEventListener('contextmenu', disableShowOnlyVideos);
    a.appendChild(document.createTextNode('only videos'));
  }

  if (document.location.hash.match(/onlyvideos=(\d+)/)) {
    const n = parseInt(document.location.hash.match(/onlyvideos=(\d+)/)[1]);
    for (let i = 0; i < n; i++) {
      showOnlyVideos();
    }
  }
}());
