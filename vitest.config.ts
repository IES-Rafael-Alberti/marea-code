import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      clean: true,
      exclude: [
        "**/.stryker-tmp/**",
        "**/*.config.{js,mjs,ts}",
        "**/*.d.ts",
        "**/*.fixture.ts",
        "**/*.{spec,test}.{ts,tsx}",
        "**/catalogs/**",
        "packages/plugin-runtime/src/generated/plugin-catalog.ts",
        "**/static/**",
        "migrations/**",
      ],
      include: [
        "apps/**/src/**/*.{ts,tsx}",
        "packages/**/src/**/*.{ts,tsx}",
        "plugins/**/src/**/*.{ts,tsx}",
        "scripts/**/*.ts",
      ],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        perFile: true,
        statements: 100,
      },
    },
    exclude: [
      "**/.stryker-tmp/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/reports/**",
      "references/**",
    ],
    include: ["**/*.{spec,test}.{ts,tsx}"],
    passWithNoTests: false,
  },
});
