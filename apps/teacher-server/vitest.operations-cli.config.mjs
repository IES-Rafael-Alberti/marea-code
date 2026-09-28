import { mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

export default mergeConfig(base, {
  test: {
    include: [
      "src/platform/operations-cli/**/*.test.ts",
      "src/platform/installation/**/*.test.ts",
      "src/platform/operations/storage/sqlite-transfer-authority.integration.test.ts",
    ],
  },
});
