import { createPackageStrykerConfig } from "@marea/test-config";
export default createPackageStrykerConfig({
  extensions: "ts",
  excludeTypeTests: false,
  jsonReport: true,
});
