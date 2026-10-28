import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Every build gets its own id, baked into the code (__BUILD_ID__) and written
// to /version.json. A page left open across a deploy compares the two and asks
// the person to reload (NewVersionModal) — the release-notes version can't do
// this, it only changes when a note is published.
const BUILD_ID = process.env.BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function buildVersion(): Plugin {
  return {
    name: "build-version",
    config: () => ({ define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ id: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildVersion()],
  // @whatsatendende/types is a CommonJS workspace package reached through a
  // node_modules symlink — both Vite's dev-time dependency pre-bundling and
  // its production Rollup build resolve symlinks to the package's real path
  // (packages/types/dist/...), which falls outside the default
  // node_modules/** glob each of them uses to decide what to run through
  // CJS-to-ESM interop. Left unset, only type-only imports from it work
  // (erased entirely at compile time, so they never hit this path); any
  // real value import fails to resolve — "X is not exported by ..." in a
  // production build, "does not provide an export named 'X'" in dev.
  optimizeDeps: {
    include: ["@whatsatendende/types"],
  },
  build: {
    commonjsOptions: {
      include: [/packages\/types\/dist/, /node_modules/],
    },
    rollupOptions: {
      output: {
        // pdf.js's worker is a ".mjs" file, and nginx's stock mime.types (the nginx:1.27 image's included) has no
        // entry for that extension — it was served as octet-stream, and a browser refuses to run a module script
        // that isn't JavaScript, so PDFs never drew (thumbnail and viewer both stayed empty). A ".js" name gets
        // application/javascript from any server.
        assetFileNames: (asset) => ((asset.names ?? [asset.name ?? ""]).some((name) => name.endsWith(".mjs")) ? "assets/[name]-[hash].js" : "assets/[name]-[hash][extname]"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/uploads": { target: "http://localhost:4000", changeOrigin: true },
      "/socket.io": { target: "http://localhost:4000", changeOrigin: true, ws: true },
    },
  },
});
