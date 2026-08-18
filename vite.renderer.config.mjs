import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  // `electron` is provided by the runtime (exposed to the renderer via the
  // preload script), so it must not be bundled. Node built-ins are also
  // unavailable in the Chromium ESM loader.
  build: {
    rollupOptions: {
      external: ['electron', 'node:fs', 'node:path', 'node:url', 'node:crypto'],
      input: {
        loadingPage: 'loadingPage.html',
        startPage: 'startPage.html',
        mainPage: 'mainPage.html',
      },
    },
  },
});
