import { Component, signal } from '@angular/core';

@Component({
  selector: 'erome-site',
  standalone: true,
  template: `
    <header class="topbar">
      <a class="brand" href="#top" aria-label="Erome Length home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>length<span class="brand-dot">.</span></span>
      </a>
      <button class="menu-toggle" type="button" (click)="toggleMenu()"
              [attr.aria-expanded]="menuOpen()" aria-label="Toggle navigation">☰</button>
      <nav [class.open]="menuOpen()" aria-label="Main navigation">
        <a href="#features" (click)="menuOpen.set(false)">Features</a>
        <a href="#privacy" (click)="menuOpen.set(false)">Privacy</a>
        <a href="#install" (click)="menuOpen.set(false)">How it works</a>
        <a class="nav-cta" href="/erome.user.js" download>Get the userscript <span aria-hidden="true">↗</span></a>
      </nav>
    </header>

    <main id="top">
      <section class="hero page-wrap">
        <div class="hero-copy">
          <div class="eyebrow"><span class="live-dot"></span> A lighter way to browse Erome</div>
          <h1>Know the length<br>before you <em>press play.</em></h1>
          <p class="hero-lede">See video durations at a glance. Filter out clips that are too short and find video albums faster—with a tiny userscript that stays in your browser.</p>
          <div class="hero-actions">
            <a class="button button-dark" href="/erome.user.js" download>Install the userscript <span aria-hidden="true">↗</span></a>
            <a class="text-link" href="#demo">Explore the controls <span aria-hidden="true">↓</span></a>
          </div>
          <div class="trust-row"><span>Free &amp; open source</span><span>Local-first</span><span>No account needed</span></div>
        </div>

        <div class="hero-art" aria-label="Preview of the duration filter controls">
          <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
          <div class="float-note note-top"><span class="note-icon">↗</span><span><b>At a glance</b><small>Durations beside each video</small></span></div>
          <div class="preview-window">
            <div class="preview-bar"><span></span><span></span><span></span><b>erome.com / album</b></div>
            <div class="preview-content">
              <div class="preview-title"><div><small>ALBUM</small><strong>Late night moments</strong></div><span class="album-count">12 videos</span></div>
              <div class="video-row"><div class="thumb thumb-one"><span>▶</span></div><div class="video-info"><b>clip_01.mp4</b><small>1080p · video</small></div><span class="duration-pill">12:48</span></div>
              <div class="video-row"><div class="thumb thumb-two"><span>▶</span></div><div class="video-info"><b>clip_02.mp4</b><small>720p · video</small></div><span class="duration-pill">3:16</span></div>
              <div class="video-row"><div class="thumb thumb-three"><span>▶</span></div><div class="video-info"><b>clip_03.mp4</b><small>1080p · video</small></div><span class="duration-pill">28:04</span></div>
            </div>
          </div>
          <div class="float-note note-bottom"><span class="filter-icon">⌁</span><span><b>Stay in control</b><small>Filter by the time you have</small></span></div>
          <div class="art-spark spark-one">✳</div><div class="art-spark spark-two">✳</div>
        </div>
      </section>

      <section class="ticker" aria-label="Product highlights"><div class="ticker-inner"><span>Less guesswork</span><i>✳</i><span>More watching</span><i>✳</i><span>Made for albums</span><i>✳</i><span>Nothing to sign up for</span><i>✳</i></div></section>

      <section class="demo-section page-wrap" id="demo">
        <div class="section-heading"><div><div class="eyebrow">A small tool, a better flow</div><h2>Your time.<br><em>Your filter.</em></h2></div><p>Set a minimum length and short videos get out of your way. The control panel lives right on the page, ready whenever you need it.</p></div>
        <div class="demo-card">
          <div class="demo-controls">
            <div class="demo-kicker"><span class="live-dot"></span> TRY THE FILTER</div>
            <h3>How much time<br>have you got?</h3>
            <p>Drag the slider. Clips under the selected length disappear from this preview.</p>
            <label for="demo-range">Minimum duration <strong>{{ demoLabel() }}</strong></label>
            <input id="demo-range" type="range" min="0" max="180" step="15" [value]="minimumSeconds()" (input)="changeMinimum($event)">
            <div class="range-labels"><span>Off</span><span>3 min</span></div>
            <div class="demo-footnote"><span class="checkmark">✓</span> This is a local preview—no data is sent.</div>
          </div>
          <div class="demo-results">
            <div class="results-head"><div><small>ALBUM PREVIEW</small><h3>Weekend collection</h3></div><span class="result-count">{{ visibleClips().length }} clips</span></div>
            @for (clip of visibleClips(); track clip.name) {
              <div class="result-row"><span class="result-play">▶</span><div class="result-meta"><b>{{ clip.name }}</b><small>{{ clip.quality }} · Added recently</small></div><span class="result-duration">{{ clip.duration }}</span></div>
            } @empty {
              <div class="empty-state"><span>⌁</span><b>No clips match that filter.</b><small>Try a shorter minimum duration.</small></div>
            }
            <div class="results-bottom">Showing videos with a duration of at least {{ demoLabel() }}.</div>
          </div>
        </div>
      </section>

      <section class="features-section" id="features">
        <div class="page-wrap">
          <div class="section-heading feature-heading"><div><div class="eyebrow">Useful by design</div><h2>Just the details<br>you <em>came for.</em></h2></div><p>No crowded dashboard. No setup maze. Just a few thoughtful controls that make browsing albums feel easier.</p></div>
          <div class="feature-grid">
            <article class="feature-card"><span class="feature-number">01</span><div class="feature-icon icon-lime">◷</div><h3>Duration, right there</h3><p>Video lengths appear alongside each player so you can choose what to watch without opening every clip.</p></article>
            <article class="feature-card"><span class="feature-number">02</span><div class="feature-icon icon-lilac">⌁</div><h3>Filter the short ones</h3><p>Pick a minimum duration and focus on clips that fit the moment. Turn the filter off whenever you like.</p></article>
            <article class="feature-card"><span class="feature-number">03</span><div class="feature-icon icon-peach">▦</div><h3>Find video albums</h3><p>Show albums and groups with video content, with an optional minimum video count for album pages.</p></article>
          </div>
        </div>
      </section>

      <section class="privacy-section page-wrap" id="privacy">
        <div class="privacy-copy"><div class="eyebrow"><span class="live-dot"></span> Private by default</div><h2>Your browser.<br><em>Your business.</em></h2><p>The userscript is built to do one job on Erome pages. There are no accounts, analytics, or remote scripts, and your filter choices stay on the current page.</p><a class="text-link" href="https://github.com/drdre1/erome-userscript" target="_blank" rel="noopener noreferrer">Read the source on GitHub <span aria-hidden="true">↗</span></a></div>
        <div class="privacy-list"><div><span class="privacy-check">✓</span><span><b>Local duration cache</b><small>Only detected video lengths are cached in browser storage.</small></span></div><div><span class="privacy-check">✓</span><span><b>Scoped requests</b><small>HTTPS duration lookups are limited to Erome domains.</small></span></div><div><span class="privacy-check">✓</span><span><b>No data collection</b><small>No account, payment, or browsing-history data is uploaded.</small></span></div><div><span class="privacy-check">✓</span><span><b>Open source</b><small>Review exactly what runs before you install it.</small></span></div></div>
      </section>

      <section class="install-section" id="install"><div class="page-wrap install-inner"><div class="eyebrow">Up and running in a minute</div><h2>Three steps.<br><em>That’s it.</em></h2><div class="steps"><article><span>01</span><h3>Choose a userscript manager</h3><p>Install Tampermonkey or Violentmonkey in your browser.</p></article><article><span>02</span><h3>Add the script</h3><p>Use the button below to open the installable Erome userscript.</p></article><article><span>03</span><h3>Browse like usual</h3><p>Open an Erome album. Durations and controls appear automatically.</p></article></div><a class="button button-lime" href="/erome.user.js" download>Get Erome Length <span aria-hidden="true">↗</span></a><p class="install-meta">Free · Open source · No account required</p></div></section>
    </main>

    <footer class="footer page-wrap"><a class="brand" href="#top"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>length<span class="brand-dot">.</span></span></a><p>A tiny helper for a better browsing rhythm.</p><div><a href="https://github.com/drdre1/erome-userscript" target="_blank" rel="noopener noreferrer">GitHub</a><a href="#privacy">Privacy</a><a href="#install">Install</a></div><small>© Erome Length · Open source software</small></footer>
  `,
})
export class SiteComponent {
  readonly menuOpen = signal(false);
  readonly minimumSeconds = signal(30);
  private readonly clips = [
    { name: 'clip_01.mp4', quality: '1080p', seconds: 42, duration: '0:42' },
    { name: 'clip_02.mp4', quality: '720p', seconds: 128, duration: '2:08' },
    { name: 'clip_03.mp4', quality: '1080p', seconds: 194, duration: '3:14' },
    { name: 'clip_04.mp4', quality: '720p', seconds: 56, duration: '0:56' },
  ];

  toggleMenu(): void {
    this.menuOpen.update((value) => !value);
  }

  visibleClips() {
    return this.clips.filter((clip) => clip.seconds >= this.minimumSeconds());
  }

  demoLabel(): string {
    const seconds = this.minimumSeconds();
    if (seconds === 0) return 'Off';
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${minutes} min`;
  }

  changeMinimum(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) this.minimumSeconds.set(Number(input.value));
  }
}
