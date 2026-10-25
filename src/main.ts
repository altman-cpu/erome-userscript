import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

function mount(): void {
  if (!document.body || document.getElementById('erome-userscript-controls')) return;
  const host = document.createElement('erome-controls');
  host.id = 'erome-userscript-controls';
  document.body.appendChild(host);
  bootstrapApplication(AppComponent).catch(() => {
    host.remove();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
