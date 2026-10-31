/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';
import { captureSink } from './capture/vite-capture-sink';

// scripts/dev-local.mjs sets APP_LOCAL_DEV=1: plain HTTP on 127.0.0.1 (a secure
// context, so WebXR + IWER work) without the CLI-managed Playwright browser.
// APP_PORT lets parallel worktrees run their own dev servers side by side.
const localDev = process.env.APP_LOCAL_DEV === '1';
const port = Number(process.env.APP_PORT ?? 8081);

export default defineConfig({
  // captureSink is serve-only: it receives in-page recordings into captures/.
  plugins: [iwsdkDev(localDev ? { https: false } : {}), captureSink()],
  server: localDev
    ? { host: '127.0.0.1', port, strictPort: true, open: false }
    : { host: '0.0.0.0', port, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (its own three vs the app's super-three alias). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
      // pre-bundled so the first page load never triggers a re-optimize reload (src/art/geometry.ts)
      'three/examples/jsm/utils/BufferGeometryUtils.js',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
