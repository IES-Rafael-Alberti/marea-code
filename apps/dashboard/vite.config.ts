import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  build: {
    assetsDir: "assets",
    emptyOutDir: true,
    manifest: true,
    outDir: "dist",
    sourcemap: false,
  },
});
