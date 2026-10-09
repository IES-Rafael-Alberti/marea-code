import { defineConfig } from "vite";

export default defineConfig({
  base: "/dashboard/",
  build: {
    target: ["chrome107", "edge107", "firefox104", "safari17"],
    rolldownOptions: { input: { index: "index.html", setup: "setup.html" } },
    assetsDir: "assets",
    emptyOutDir: true,
    manifest: true,
    outDir: "dist",
    sourcemap: false,
  },
});
