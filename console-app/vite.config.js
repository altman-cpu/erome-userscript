import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bind to all interfaces and allow any Host header so the app works behind
// reverse proxies / sandboxed preview hosts.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
});
