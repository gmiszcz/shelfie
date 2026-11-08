/// <reference types="vitest/config" />
import { readFileSync } from 'fs';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

// The frontend package version, injected as the build constant `__APP_VERSION__` so the
// React Query persist cache is busted automatically on a new release (see queries/queryClient.ts).
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const backendPort = rootEnv.PORT || process.env.PORT || '8000';

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      // Allow access through `tailscale serve` (https://<machine>.<tailnet>.ts.net).
      // The server still binds to 127.0.0.1 only; Tailscale proxies to it.
      allowedHosts: ['.ts.net'],
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
          // Send X-Forwarded-Host so the backend CSRF check can match the
          // browser's Origin (e.g. https://<machine>.ts.net:8443).
          xfwd: true,
          // The voice transcription endpoint (/api/transcribe/stream) is a
          // WebSocket. Without ws:true Vite proxies HTTP only, the upgrade is
          // dropped, and the mic records forever with no transcript.
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      // jsdom suites are CPU-heavy; too many parallel workers starve the main
      // process and vitest's worker RPC times out ("Timeout calling snapshotSaved").
      maxWorkers: 4,
      minWorkers: 1,
    },
  };
});
