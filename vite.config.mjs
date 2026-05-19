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
  },
});
