import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // @whatsunivida/types is a CommonJS workspace package reached through a
  // node_modules symlink — both Vite's dev-time dependency pre-bundling and
  // its production Rollup build resolve symlinks to the package's real path
  // (packages/types/dist/...), which falls outside the default
  // node_modules/** glob each of them uses to decide what to run through
  // CJS-to-ESM interop. Left unset, only type-only imports from it work
  // (erased entirely at compile time, so they never hit this path); any
  // real value import fails to resolve — "X is not exported by ..." in a
  // production build, "does not provide an export named 'X'" in dev.
  optimizeDeps: {
    include: ["@whatsunivida/types"],
  },
  build: {
    commonjsOptions: {
      include: [/packages\/types\/dist/, /node_modules/],
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
