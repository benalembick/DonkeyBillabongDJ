// Bundles the Electron main + preload scripts (TypeScript) into CommonJS.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  // Loaded from node_modules at runtime: the native addon (unpacked from the asar in packaged
  // builds) and electron-updater, which lazy-loads its per-platform updaters.
  external: ["electron", "electron-updater", "onnxruntime-node"],
  logLevel: "info",
};

await Promise.all([
  build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" }),
  build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" }),
  build({ ...common, entryPoints: ["electron/stems/worker.ts"], outfile: "dist-electron/stems-worker.cjs" }),
]);
