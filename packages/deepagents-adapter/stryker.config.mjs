import { createPackageStrykerConfig } from "@marea/test-config";

export default createPackageStrykerConfig({
  excludeTypeTests: true,
  extensions: "ts",
  ignoreStatic: false,
  jsonReport: false,
});
