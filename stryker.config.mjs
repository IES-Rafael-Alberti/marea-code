/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  concurrency: 4,
  coverageAnalysis: "perTest",
  ignoreStatic: false,
  ignorePatterns: [
    ".stryker-tmp/**",
    "**/coverage/**",
    "coverage/**",
    "**/reports/**",
    "docs/**",
    "references/**",
  ],
  incremental: false,
  mutate: [
    "scripts/**/*.ts",
    "!**/*.{spec,test}.{ts,tsx}",
    "!**/*.d.ts",
    "!**/*.fixture.ts",
    "!**/catalogs/**",
    "!packages/plugin-runtime/src/generated/plugin-catalog.ts",
    "!**/static/**",
  ],
  plugins: ["@stryker-mutator/vitest-runner"],
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  reporters: ["clear-text", "json", "progress"],
  testRunner: "vitest",
  thresholds: {
    break: 100,
    high: 100,
    low: 100,
  },
  vitest: {
    configFile: "vitest.config.ts",
  },
};
