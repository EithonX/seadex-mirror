import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("frontend"),
  build: {
    outDir: resolve("dist"),
    emptyOutDir: true,
  },
});
