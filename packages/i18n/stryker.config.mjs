import { createPackageStrykerConfig } from "@marea/test-config";

const config = createPackageStrykerConfig({
  excludeTypeTests: false,
  extensions: "ts",
  ignoreStatic: false,
  jsonReport: true,
});

export default {
  ...config,
  mutate: ["src/**/*.ts", "!src/**/*.{spec,test}.{ts,tsx}", "!src/catalogs/**"],
};
