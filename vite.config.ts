import { defineConfig } from "vite";

// Tauri expects a fixed port; everything is bundled locally (no CDNs).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    watch: { ignored: ["**/src-tauri/**", "**/core/**", "**/target/**"] },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "es2022",
    sourcemap: false,
    minify: "esbuild",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
});
