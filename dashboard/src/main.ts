import 'zone.js';
import '@angular/compiler';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { bootstrapApplication } from '@angular/platform-browser';

declare global {
  interface Window {
    EroClipRegistry?: any;
  }
}

interface ClipRow {
  id: string;
  url: string;
  ext: string | null;
  durationMs: number | null;
  durationLabel: string | null;
  width: number | null;
  height: number | null;
  pixels: number | null;
  is4k: boolean;
  albumId: string | null;
  albumTitle: string | null;
  username: string | null;
  index: number | null;
  seenCount: number;
  source: string;
}

@Component({
  selector: 'ecr-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="shell">
      <header class="hero">
        <div class="hero-left">
          <div
            class="coin"
            [class.spinning]="coinSpinning()"
            (click)="pulseAngularForce()"
            title="Click to apply Angular Force rotational impulse"
          >
            &ETH;
          </div>
          <div>
            <h1 class="hero-title">
              EroClipRegistry <span style="color: var(--gold)">v{{ version() }}</span> — Angular Force Console
            </h1>
            <p class="hero-sub">
              Single brand: <span class="mono">{{ brand() }}</span> &middot;
              Continuous MutationObserver &middot; Personalized Dogecoin Theme &middot; Eightfold USD Envelope
            </p>
          </div>
        </div>
        <div class="pill-bar">
          <span class="bevel-tag">&ETH; {{ personaTag() }}</span>
          <span class="bevel-tag">{{ observerBadge() }}</span>
          <span class="bevel-tag">USD \${{ usdFormatted() }}</span>
          <a class="btn btn-primary" href="./erome.user.js" target="_blank" rel="noopener">
            Install erome.user.js
          </a>
        </div>
      </header>

      <section class="stats-row">
        <div class="stat-card">
          <div class="stat-label">Clips Registered</div>
          <div class="stat-value">{{ clips().length }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Movies (Albums)</div>
          <div class="stat-value">{{ movies().length }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Tracked Users</div>
          <div class="stat-value">{{ users().length }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Auto 4K Clips</div>
          <div class="stat-value">{{ fourKCount() }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Angular Force Pulses</div>
          <div class="stat-value">{{ torquePulses() }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Dropped Unused Nodes</div>
          <div class="stat-value">{{ droppedNodes() }}</div>
        </div>
      </section>

      <div class="grid-2">
        <section class="card">
          <h2>
            <span>MariaDB-Style Registry Tables</span>
            <span class="mono" style="font-size: 11px; color: var(--muted)">storage: {{ storageMode() }}</span>
          </h2>

          <div class="controls-bar">
            <button class="btn" type="button" (click)="addSimulatedClip(true)">+ Add 4K UHD Clip</button>
            <button class="btn" type="button" (click)="addSimulatedClip(false)">+ Add 1080p Clip</button>
            <button class="btn" type="button" (click)="dropUnusedNode()">Simulate Unused Work</button>
            <button class="btn" type="button" (click)="togglePause()">
              {{ isPaused() ? 'Resume Observer' : 'Pause Observer' }}
            </button>
            <button class="btn" type="button" (click)="pulseAngularForce()">Angular Force &ETH;</button>
          </div>

          <div class="tabs">
            <button class="tab" [class.active]="activeTab() === 'clips'" (click)="activeTab.set('clips')">
              clips ({{ clips().length }})
            </button>
            <button class="tab" [class.active]="activeTab() === 'movies'" (click)="activeTab.set('movies')">
              movies ({{ movies().length }})
            </button>
            <button class="tab" [class.active]="activeTab() === 'users'" (click)="activeTab.set('users')">
              users ({{ users().length }})
            </button>
          </div>

          <div *ngIf="activeTab() === 'clips'" style="overflow-x: auto">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Clip</th>
                  <th>Duration</th>
                  <th>Resolution</th>
                  <th>Movie</th>
                  <th>User</th>
                  <th>8-Fold</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let c of clips()">
                  <td class="mono">{{ c.index ?? '-' }}</td>
                  <td class="mono">{{ shortUrl(c.url) }}</td>
                  <td class="mono">{{ c.durationLabel || 'pending' }}</td>
                  <td>
                    <span class="mono">{{ c.width ? c.width + 'x' + c.height : '-' }}</span>
                    <span *ngIf="c.is4k" class="bevel-tag" style="padding: 1px 6px; margin-left: 6px">4K</span>
                  </td>
                  <td class="mono">{{ c.albumId || '-' }}</td>
                  <td class="mono">{{ c.username || '-' }}</td>
                  <td>
                    <button class="btn" style="padding: 3px 8px" type="button" (click)="inspectClip(c.url)">
                      Inspect
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div *ngIf="activeTab() === 'movies'" style="overflow-x: auto">
            <table>
              <thead>
                <tr>
                  <th>Album ID</th>
                  <th>Title</th>
                  <th>Uploader</th>
                  <th>Clips</th>
                  <th>Runtime</th>
                  <th>4K</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let m of movies()">
                  <td class="mono">{{ m.albumId }}</td>
                  <td>{{ m.title || '-' }}</td>
                  <td class="mono">{{ m.username || '-' }}</td>
                  <td class="mono">{{ m.clipCount }}</td>
                  <td class="mono">{{ m.totalDurationLabel || '0:00' }}</td>
                  <td class="mono">{{ m.fourKCount }} ({{ m.has4k ? 'YES' : 'no' }})</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div *ngIf="activeTab() === 'users'" style="overflow-x: auto">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Clips</th>
                  <th>Movies</th>
                  <th>4K Clips</th>
                  <th>Total Runtime (ms)</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let u of users()">
                  <td class="mono">{{ u.username }}</td>
                  <td class="mono">{{ u.clipCount }}</td>
                  <td class="mono">{{ u.albumCount }}</td>
                  <td class="mono">{{ u.fourKCount }}</td>
                  <td class="mono">{{ u.totalDurationMs }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2>
            <span>Dogecoin Personalizer &amp; USD Settlement Slot</span>
            <span class="mono" style="font-size: 11px; color: var(--muted)">local metadata only</span>
          </h2>

          <div class="field-row">
            <input
              class="input"
              type="text"
              maxlength="32"
              [(ngModel)]="personaInput"
              placeholder="Personalized Dogecoin badge handle"
            />
            <button class="btn btn-primary" type="button" (click)="applyPersona()">Set &ETH; Tag</button>
          </div>

          <div class="field-row">
            <input
              class="input"
              type="text"
              style="max-width: 84px"
              [(ngModel)]="currencyInput"
              placeholder="USD"
            />
            <input
              class="input"
              type="number"
              step="0.5"
              min="0"
              [(ngModel)]="usdInput"
              placeholder="USD metadata amount"
            />
            <button class="btn" type="button" (click)="applySettlement()">Apply USD</button>
          </div>
          <div *ngIf="settlementMsg()" [class]="settlementOk() ? 'msg-ok' : 'msg-err'" style="margin-bottom: 10px">
            {{ settlementMsg() }}
          </div>

          <h2 style="margin-top: 14px">
            <span>Genesis Language Stack</span>
            <button class="btn btn-primary" type="button" (click)="executeGenesis()">Run Genesis</button>
          </h2>
          <textarea class="textarea" [(ngModel)]="genesisScript"></textarea>
          <pre
            *ngIf="genesisOutput()"
            class="fold-pre"
            style="margin-top: 8px; background: #100d07; padding: 8px; border: 1px solid var(--border); max-height: 155px; overflow: auto"
          >{{ genesisOutput() }}</pre>
        </section>
      </div>

      <section class="card">
        <h2>
          <span>Eightfold Encoded Payload Inspector (ecr8.*)</span>
          <div style="display: flex; gap: 8px">
            <button class="btn" type="button" (click)="verifyToken()">Verify Checksum</button>
            <button class="btn" type="button" (click)="tamperToken()">Simulate Tamper</button>
          </div>
        </h2>

        <div class="field-row">
          <input class="input" type="text" [(ngModel)]="tokenInput" placeholder="ecr8.<base64url>.<checksum>" />
        </div>
        <div *ngIf="decodeStatus()" [class]="decodeValid() ? 'msg-ok' : 'msg-err'">
          {{ decodeStatus() }}
        </div>

        <div class="fold-grid" *ngIf="decodedFolds().length">
          <div class="fold-box" *ngFor="let f of decodedFolds()">
            <div class="fold-title">Fold {{ f.idx }} &middot; {{ f.name }}</div>
            <pre class="fold-pre">{{ f.json }}</pre>
          </div>
        </div>
      </section>

      <section class="card stage-wrap">
        <h2>
          <span>Live Simulated Album DOM Stage (Observed by Real erome.user.js)</span>
          <span class="mono" style="font-size: 11px; color: var(--muted)">/a/aurora-reel</span>
        </h2>
        <div class="album" id="demo-album">
          <div class="album-head">
            <a href="/a/aurora-reel" style="color: var(--gold); text-decoration: none">
              <h3 class="album-title">Aurora Reel Showcase</h3>
            </a>
            <div class="user">
              Uploader: <a href="/shibe_director" style="color: var(--text)">shibe_director</a>
            </div>
          </div>
          <div class="stage-grid" id="demo-stage-grid"></div>
        </div>
      </section>
    </div>
  `
})
export class AppComponent implements OnInit, OnDestroy {
  brand = signal('erome-clip-registry');
  version = signal('1.2');
  personaTag = signal('Much4K');
  usdFormatted = signal('0.00');
  observerBadge = signal('BOOTING');
  storageMode = signal('localStorage');
  isPaused = signal(false);
  torquePulses = signal(0);
  droppedNodes = signal(0);
  coinSpinning = signal(false);

  clips = signal<ClipRow[]>([]);
  movies = signal<any[]>([]);
  users = signal<any[]>([]);
  activeTab = signal<'clips' | 'movies' | 'users'>('clips');

  fourKCount = computed(() => this.clips().filter((c) => c.is4k).length);

  personaInput = 'Much4K';
  currencyInput = 'USD';
  usdInput = 15;
  settlementMsg = signal('');
  settlementOk = signal(true);

  genesisScript = [
    '# Declarative Genesis stack commands',
    'PERSONA Shibe4K',
    'SETTLE USD 19.99',
    'FORCE',
    'SELECT clips WHERE 4k'
  ].join('\n');
  genesisOutput = signal('');

  tokenInput = '';
  decodeStatus = signal('');
  decodeValid = signal(true);
  decodedFolds = signal<Array<{ idx: number; name: string; json: string }>>([]);

  private seq = 0;
  private pollId: any = 0;

  async ngOnInit(): Promise<void> {
    this.mountDemoClip('/demo-media/aurora-opening-4k.mp4', 3840, 2160, 94);
    this.mountDemoClip('/demo-media/desert-dusk-1080p.mp4', 1920, 1080, 47);

    const res = await fetch('./erome.user.js');
    const code = await res.text();
    const runner = new Function(code);
    runner();

    this.syncFromRegistry();
    const all = this.clips();
    if (all.length > 0) {
      this.inspectClip(all[0].url);
    }

    this.pollId = setInterval(() => this.syncFromRegistry(), 600);
  }

  ngOnDestroy(): void {
    if (this.pollId) clearInterval(this.pollId);
  }

  private mountDemoClip(pathUrl: string, w: number, h: number, durationSec: number): HTMLElement {
    this.seq++;
    const group = document.createElement('div');
    group.className = 'media-group';
    const videoWrap = document.createElement('div');
    videoWrap.className = 'video';
    const player = document.createElement('div');
    player.className = 'player';
    const video = document.createElement('video');
    video.preload = 'none';
    const source = document.createElement('source');
    source.setAttribute('src', pathUrl);
    source.setAttribute('type', 'video/mp4');
    video.appendChild(source);

    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => w });
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => h });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => durationSec });
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 });

    player.appendChild(video);
    videoWrap.appendChild(player);
    group.appendChild(videoWrap);

    const grid = document.getElementById('demo-stage-grid');
    if (grid) grid.appendChild(group);
    return group;
  }

  syncFromRegistry(): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    const st = R.status();
    this.brand.set(st.brand);
    this.version.set(st.version);
    this.personaTag.set(st.persona?.tag || 'Much4K');
    this.usdFormatted.set(st.settlement?.amountUsd || '0.00');
    this.storageMode.set(st.storage);
    this.isPaused.set(!!st.paused);
    this.torquePulses.set(st.torquePulses || 0);
    this.droppedNodes.set(st.droppedNodes || 0);
    this.observerBadge.set(!st.active ? 'STOPPED' : st.paused ? 'PAUSED' : 'OBSERVING');

    const clipRows = Object.values(R.clips()) as ClipRow[];
    clipRows.sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
    this.clips.set(clipRows);
    this.movies.set(Object.values(R.movies()));
    this.users.set(Object.values(R.users()));
  }

  addSimulatedClip(is4k: boolean): void {
    const idx = this.seq + 1;
    const tag = is4k ? 'uhd-4k' : 'hd-1080p';
    const url = `/demo-media/reel-${idx}-${tag}.mp4`;
    this.mountDemoClip(url, is4k ? 3840 : 1920, is4k ? 2160 : 1080, 35 + idx * 14);
    setTimeout(() => {
      this.pulseAngularForce();
      this.syncFromRegistry();
      this.inspectClip(new URL(url, document.baseURI).href);
    }, 50);
  }

  dropUnusedNode(): void {
    const ghost = this.mountDemoClip(`/demo-media/transient-${Date.now()}.mp4`, 1920, 1080, 12);
    Promise.resolve().then(() => {
      ghost.remove();
      setTimeout(() => this.syncFromRegistry(), 50);
    });
  }

  togglePause(): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    if (R.status().paused) R.resume();
    else R.pause();
    this.syncFromRegistry();
  }

  pulseAngularForce(): void {
    const R = window.EroClipRegistry;
    if (R) R.angularForce();
    this.coinSpinning.set(false);
    setTimeout(() => this.coinSpinning.set(true), 10);
    setTimeout(() => this.coinSpinning.set(false), 720);
    this.syncFromRegistry();
  }

  applyPersona(): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    const p = R.personalize(this.personaInput);
    this.personaInput = p.tag;
    this.pulseAngularForce();
    this.syncFromRegistry();
    if (this.clips().length) this.inspectClip(this.clips()[0].url);
  }

  applySettlement(): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    try {
      const s = R.setUsd(this.currencyInput, this.usdInput);
      this.settlementOk.set(true);
      this.settlementMsg.set(`Saved local settlement slot: ${s.currency} $${s.amountUsd} (${s.mode})`);
      this.syncFromRegistry();
      if (this.clips().length) this.inspectClip(this.clips()[0].url);
    } catch (err: any) {
      this.settlementOk.set(false);
      this.settlementMsg.set(err?.message || String(err));
    }
  }

  executeGenesis(): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    const out = R.genesis(this.genesisScript);
    this.genesisOutput.set(JSON.stringify(out, null, 2));
    this.syncFromRegistry();
    if (this.clips().length) this.inspectClip(this.clips()[0].url);
  }

  inspectClip(url: string): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    const enc = R.encodeEightfold(url);
    if (!enc) return;
    this.tokenInput = enc.token;
    this.verifyToken();
  }

  verifyToken(): void {
    const R = window.EroClipRegistry;
    if (!R) return;
    const res = R.decodeEightfold(this.tokenInput);
    this.decodeValid.set(!!res.valid);
    if (!res.valid) {
      this.decodeStatus.set(`Rejected: ${res.error}`);
      this.decodedFolds.set([]);
      return;
    }
    this.decodeStatus.set(`Verified 8-fold envelope (checksum ${res.envelope.integrity.checksum}, currency ${res.envelope.settlement.currency})`);
    const order = ['identity', 'media', 'movie', 'creator', 'lifecycle', 'persona', 'settlement', 'integrity'];
    this.decodedFolds.set(
      order.map((name, i) => ({
        idx: i + 1,
        name,
        json: JSON.stringify(res.envelope[name], null, 2)
      }))
    );
  }

  tamperToken(): void {
    if (!this.tokenInput) return;
    this.tokenInput = this.tokenInput.slice(0, -2) + (this.tokenInput.endsWith('xx') ? 'yy' : 'xx');
    this.verifyToken();
  }

  shortUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname;
    } catch {
      return url;
    }
  }
}

bootstrapApplication(AppComponent).catch((err) => console.error(err));
