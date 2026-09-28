import { createPackageStrykerConfig } from "@marea/test-config";

export default createPackageStrykerConfig({
  excludeTypeTests: false,
  extensions: "ts",
  ignoreStatic: true,
  jsonReport: true,
});
