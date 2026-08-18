import { defineConfig } from 'vite'

// https://vitejs.dev/config
//
// These heavy CommonJS protocol libraries do not bundle well with Rollup:
// `minecraft-data` is downloaded to the user-data cache during boot. The
// remaining heavy CommonJS protocol libraries are required from node_modules
// at runtime rather than bundled by Rollup.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'minecraft-protocol',
        'adm-zip',
        'protobufjs',
        'tar'
      ]
    }
  }
})
