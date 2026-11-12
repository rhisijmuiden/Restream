import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080', '/live': 'http://127.0.0.1:8080' },
  },
  build: {
    outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900,
    // The console and the embeddable player (/embed/<id>, served by the server with its own access checks).
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), embed: resolve(import.meta.dirname, 'embed.html') } },
  },
});
