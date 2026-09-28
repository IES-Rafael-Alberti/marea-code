import { mergeConfig } from "vitest/config";
import base from "./vitest.config.mjs";

export default mergeConfig(base, {
  test: { include: ["src/platform/operator-cli/**/*.test.ts"] },
});
