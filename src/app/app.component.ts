import { Component, inject, signal } from '@angular/core';
import { DurationService } from './duration.service';

@Component({
  selector: 'erome-controls',
  standalone: true,
  template: `
    <section class="panel" aria-label="Erome video controls">
      <header class="panel-header">
        <div>
          <strong>Video controls</strong>
          <span class="status">{{ durations.resolvedVideos() }} / {{ durations.totalVideos() }} durations</span>
        </div>
        <button type="button" class="collapse" (click)="toggleExpanded()"
                [attr.aria-expanded]="expanded()" aria-label="Toggle controls">
          {{ expanded() ? '−' : '+' }}
        </button>
      </header>

      @if (expanded()) {
        <div class="panel-body">
          <label for="min-duration">Hide videos shorter than {{ durationLabel() }}</label>
          <input id="min-duration" type="range" min="0" max="3600" step="5"
                 [value]="durations.minDuration()" (input)="setDuration($event)" />
          <div class="range-ends"><span>Off</span><span>60 min</span></div>

          <label class="toggle-row">
            <input type="checkbox" [checked]="durations.onlyVideos()" (change)="setOnlyVideos($event)" />
            <span>Show video albums/groups only</span>
          </label>

          <label for="album-count">Minimum videos per album</label>
          <input id="album-count" type="number" min="1" max="99" step="1"
                 [value]="durations.minAlbumVideos()" (change)="setAlbumCount($event)" />
          <p class="hint">Settings apply on this page only. No account data is collected or sent.</p>
        </div>
      }
    </section>
  `,
})
export class AppComponent {
  readonly durations = inject(DurationService);
  readonly expanded = signal(true);

  constructor() {
    this.durations.start();
  }

  toggleExpanded(): void {
    this.expanded.update((value) => !value);
  }

  durationLabel(): string {
    const seconds = this.durations.minDuration();
    if (seconds === 0) return 'Off';
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${minutes} min`;
  }

  setDuration(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) this.durations.setMinDuration(Number(input.value));
  }

  setOnlyVideos(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) this.durations.setOnlyVideos(input.checked);
  }

  setAlbumCount(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) this.durations.setMinAlbumVideos(Number(input.value));
  }
}
