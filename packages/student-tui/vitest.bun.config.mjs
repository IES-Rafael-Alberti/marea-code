import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/.stryker-tmp/**", "**/node_modules/**"],
    include: ["src/**/*.{spec,test}.{ts,tsx}", "tests-bun/**/*.integration.tsx"],
    passWithNoTests: false,
  },
});
