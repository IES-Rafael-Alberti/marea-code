import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  build: {
    rolldownOptions: { input: { index: "index.html", setup: "setup.html" } },
    assetsDir: "assets",
    emptyOutDir: true,
    manifest: true,
    outDir: "dist",
    sourcemap: false,
  },
});
