import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("frontend"),
  server: {
    fs: {
      allow: [resolve(".")],
    },
  },
  build: {
    outDir: resolve("dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep the lazy sheet renderer isolated without pulling its shared dependencies
        // into the manual chunk. Otherwise Rollup may make the main entry statically
        // depend on the supposedly lazy chunk.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (normalizedId.endsWith("/frontend/src/sheet-workbook.ts")) {
            return "sheet-workbook";
          }
        },
      },
    },
  },
});
