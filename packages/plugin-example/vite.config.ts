import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file SPA build: vite-plugin-singlefile inlines all JS+CSS into
// one self-contained index.html. The plugin's HTTP server reads this
// file at boot, patches `window.__PLUGIN_BASE__` into <head> per
// request, and serves it. Keeps the CSP simple (`script-src
// 'unsafe-inline'`) and means there are no per-asset routes to wire up.
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  root: "web",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: {
    port: 5180,
    proxy: { "/api": "http://localhost:3000" },
  },
});
