import { bootstrapApplication } from '@angular/platform-browser';
import { SiteComponent } from './site.component';

bootstrapApplication(SiteComponent).catch((error: unknown) => {
  console.error('Unable to start the Erome Length website.', error);
});
