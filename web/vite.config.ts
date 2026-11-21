import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const workerUrl = 'http://127.0.0.1:8787'; // wrangler dev

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in dev: browser talks to Vite, Vite forwards backend routes to the Worker.
    proxy: {
      '/api': { target: workerUrl },
      '/auth': { target: workerUrl },
      '/r/': { target: workerUrl },
    },
  },
});
