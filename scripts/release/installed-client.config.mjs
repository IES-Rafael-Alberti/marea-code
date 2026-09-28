import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/release/installed-client.fixture.ts"],
    testTimeout: 90_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
