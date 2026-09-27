import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// "owner/name" of the GitHub repo that hosts desktop releases (from package.json "repository").
const repo = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? "")?.[1] ?? "";

// Production-only CSP. The dev server needs inline scripts for React Fast Refresh.
const CSP =
  "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; style-src 'self' 'unsafe-inline'; frame-src https://*.apple.com; " +
  "img-src 'self' data: blob: https:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https:";

function productionCsp(): Plugin {
  return {
    name: "dbdj-production-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GITHUB_REPO__: JSON.stringify(repo),
  },
  // Relative base so the built renderer loads from file:// inside Electron.
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist", target: "es2022", sourcemap: true },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
