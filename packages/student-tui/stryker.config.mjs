import { createPackageStrykerConfig } from "@marea/test-config";

export default createPackageStrykerConfig({
  excludeTypeTests: false,
  extensions: "{ts,tsx}",
  ignoreStatic: false,
  jsonReport: false,
});
