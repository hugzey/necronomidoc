import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During `vite dev`, proxy manifests + MCP to a running necronomidoc server.
// In production the same server serves this built SPA, so no proxy is needed.
const BACKEND = process.env.NECRO_BACKEND ?? "http://localhost:4319";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/data": BACKEND,
      "/mcp": BACKEND,
      "/api": BACKEND,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
