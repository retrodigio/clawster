import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "core/server": "src/core/server.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  splitting: true,
  sourcemap: true,
  // Bundle everything for distribution
  bundle: true,
  external: ["grammy", "commander"],
});
