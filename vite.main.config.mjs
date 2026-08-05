import { defineConfig } from 'vite'

// https://vitejs.dev/config
//
// These heavy CommonJS protocol libraries do not bundle well with Rollup:
// `minecraft-data` ships megabytes of per-version JSON that it loads via
// dynamic `require()`, which causes Rollup to pull in (and OOM on) every
// version. They are required from `node_modules` at runtime instead, and
// `forge.config.js` keeps `node_modules` in the packaged app to provide them.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'minecraft-protocol',
        'minecraft-data',
        'bedrock-protocol',
        'adm-zip',
        'protobufjs'
      ]
    }
  }
})
