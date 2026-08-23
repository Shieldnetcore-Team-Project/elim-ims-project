import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(dirname, '../shared/src'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(dirname, '..')] },
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    // Output to repo-root dist so Render's default Publish Directory (`dist`) works.
    outDir: '../dist',
    emptyOutDir: true,
  },
});
