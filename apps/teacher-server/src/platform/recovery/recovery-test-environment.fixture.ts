import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import { recoveryInput, writeRecoveryState } from "./recovery-test-state.fixture.js";

export function startRecoveryTest(prefix: string): {
  root: () => string;
  input: () => ReturnType<typeof recoveryInput>;
  writeState: () => void;
} {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });
  return {
    root: () => root,
    input: () => recoveryInput(root),
    writeState: () => {
      writeRecoveryState(root);
    },
  };
}
