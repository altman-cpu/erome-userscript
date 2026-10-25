import { Injectable, signal } from '@angular/core';

declare const GM: {
  xmlHttpRequest?: (details: Record<string, unknown>) => { abort: () => void };
};

const LABEL_CLASS = 'erome-video-duration';
const LINK_CLASS = 'erome-video-source-link';
const MAX_RESPONSE_BYTES = 2048;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

@Injectable({ providedIn: 'root' })
export class DurationService {
  readonly totalVideos = signal(0);
  readonly resolvedVideos = signal(0);
  readonly minDuration = signal(0);
  readonly onlyVideos = signal(false);
  readonly minAlbumVideos = signal(1);

  private observer?: MutationObserver;
  private readonly originalDisplay = new WeakMap<HTMLElement, string>();
  private readonly pending = new Map<string, Array<{ video: HTMLVideoElement; label: HTMLSpanElement }>>();

  start(): void {
    this.scan();
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  setMinDuration(seconds: number): void {
    this.minDuration.set(this.clampInteger(seconds, 0, MAX_DURATION_SECONDS));
    this.applyFilters();
  }

  setOnlyVideos(enabled: boolean): void {
    this.onlyVideos.set(enabled);
    this.applyFilters();
  }

  setMinAlbumVideos(count: number): void {
    this.minAlbumVideos.set(this.clampInteger(count, 1, 99));
    this.applyFilters();
  }

  private scan(): void {
    const sources = document.querySelectorAll<HTMLSourceElement>('.player video source');
    const videos = new Set<HTMLVideoElement>();

    sources.forEach((source) => {
      const video = source.closest('video');
      if (!video) return;
      videos.add(video);
      this.decorate(source, video);
    });

    this.totalVideos.set(videos.size);
    this.applyFilters();
  }

  private decorate(source: HTMLSourceElement, video: HTMLVideoElement): void {
    const url = this.safeMediaUrl(source.src);
    if (!url) return;

    const parent = video.parentElement;
    if (!parent) return;

    if (!parent.querySelector(`.${LINK_CLASS}`)) {
      const link = document.createElement('a');
      link.className = LINK_CLASS;
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url.href;
      parent.insertBefore(link, video);
    }

    if (!parent.querySelector(`.${LABEL_CLASS}`)) {
      const label = document.createElement('span');
      label.className = LABEL_CLASS;
      label.setAttribute('aria-live', 'polite');
      parent.insertBefore(label, video);
      this.loadDuration(url, video, label);
    }
  }

  private safeMediaUrl(raw: string): URL | null {
    try {
      const url = new URL(raw, document.baseURI);
      const host = url.hostname.toLowerCase();
      const isEromeHost = host === 'erome.com' || host.endsWith('.erome.com');
      if (url.protocol !== 'https:' || !isEromeHost || url.username || url.password) return null;
      return url;
    } catch {
      return null;
    }
  }

  private loadDuration(url: URL, video: HTMLVideoElement, label: HTMLSpanElement): void {
    const cacheKey = `$vl#${url.href}`;
    try {
      const cached = Number(window.localStorage.getItem(cacheKey));
      if (Number.isFinite(cached) && cached >= 0 && cached <= MAX_DURATION_SECONDS * 1000) {
        this.showDuration(cached, video, label);
        return;
      }
    } catch {
      // Storage may be disabled; continue without caching.
    }

    if (typeof GM === 'undefined' || !GM.xmlHttpRequest) return;
    const existing = this.pending.get(url.href);
    if (existing) {
      existing.push({ video, label });
      return;
    }
    this.pending.set(url.href, [{ video, label }]);

    let request: { abort: () => void } | undefined;
    const finishPending = (): Array<{ video: HTMLVideoElement; label: HTMLSpanElement }> => {
      const subscribers = this.pending.get(url.href) ?? [];
      this.pending.delete(url.href);
      return subscribers;
    };
    try {
      request = GM.xmlHttpRequest({
        url: url.href,
        method: 'GET',
        headers: {
          Accept: 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5',
          Range: `bytes=0-${MAX_RESPONSE_BYTES - 1}`,
        },
        responseType: 'arraybuffer',
        timeout: 8000,
        onprogress: (event: ProgressEvent & { loaded?: number }) => {
          if ((event.loaded ?? 0) > MAX_RESPONSE_BYTES) request?.abort();
        },
        onload: (response: { response?: ArrayBuffer; status?: number }) => {
          const subscribers = finishPending();
          if (response.status && response.status >= 400) return;
          const bytes = response.response instanceof ArrayBuffer
            ? new Uint8Array(response.response).subarray(0, MAX_RESPONSE_BYTES)
            : new Uint8Array();
          const duration = this.parseDuration(bytes);
          if (duration === null) return;
          try { window.localStorage.setItem(cacheKey, String(duration)); } catch { /* optional cache */ }
          subscribers.forEach((subscriber) => this.showDuration(duration, subscriber.video, subscriber.label));
        },
        onerror: finishPending,
        ontimeout: finishPending,
        onabort: finishPending,
      });
    } catch {
      finishPending();
    }
  }

  private parseDuration(bytes: Uint8Array): number | null {
    // Retain the original site's compact header heuristic, but bound all parsing to
    // the small range response and reject implausible values before displaying them.
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const marker = /\x03[\s\S]{0,64}?\xe8/.exec(binary);
    if (!marker) return null;

    const start = marker.index + marker[0].length;
    if (start + 4 > bytes.length) return null;
    const milliseconds = bytes[start] * 0x1000000
      + bytes[start + 1] * 0x10000
      + bytes[start + 2] * 0x100
      + bytes[start + 3];
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0
        || milliseconds > MAX_DURATION_SECONDS * 1000) return null;
    return milliseconds;
  }

  private showDuration(milliseconds: number, video: HTMLVideoElement, label: HTMLSpanElement): void {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    label.textContent = ` ${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds).padStart(2, '0')}`;
    video.dataset['length'] = String(totalSeconds);
    this.resolvedVideos.update((count) => count + 1);
    this.applyFilters();
  }

  private applyFilters(): void {
    const minimum = this.minDuration();
    document.querySelectorAll<HTMLElement>('.video').forEach((container) => {
      this.rememberDisplay(container);
      const video = container.querySelector<HTMLVideoElement>('.player video');
      const duration = video?.dataset['length'];
      const shouldHide = minimum > 0 && duration !== undefined && Number(duration) < minimum;
      this.setVisible(container, !shouldHide);
    });

    document.querySelectorAll<HTMLElement>('.media-group').forEach((group) => {
      this.rememberDisplay(group);
      const shouldHide = this.onlyVideos() && !group.querySelector('.video');
      this.setVisible(group, !shouldHide);
    });

    document.querySelectorAll<HTMLElement>('.album').forEach((album) => {
      this.rememberDisplay(album);
      const countText = album.querySelector('.album-videos')?.textContent ?? '';
      const count = Number.parseInt(countText, 10) || 0;
      const shouldHide = this.onlyVideos() && count < this.minAlbumVideos();
      this.setVisible(album, !shouldHide);
    });
  }

  private rememberDisplay(element: HTMLElement): void {
    if (!this.originalDisplay.has(element)) this.originalDisplay.set(element, element.style.display);
  }

  private setVisible(element: HTMLElement, visible: boolean): void {
    const original = this.originalDisplay.get(element) ?? '';
    element.style.display = visible ? original : 'none';
  }

  private clampInteger(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));
  }
}
