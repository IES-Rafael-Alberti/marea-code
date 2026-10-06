import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runProjectCommand } from "../../apps/student/src/command-runner.boundary.ts";

const root = mkdtempSync(join(tmpdir(), "marea-native-command-"));
const windows = process.platform === "win32";
const abort = new AbortController();
try {
  const result = JSON.parse(
    await runProjectCommand(
      root,
      windows ? "echo native-command & exit /b 7" : "printf native-command; exit 7",
      new AbortController().signal,
    ),
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.output.trim(), "native-command");
  assert.equal(result.stopped, false);
  const running = runProjectCommand(
    root,
    windows ? "echo ready>ready.txt & ping -n 31 127.0.0.1 >nul" : "touch ready.txt; sleep 30",
    abort.signal,
  );
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(root, "ready.txt"))) {
    assert.ok(Date.now() < deadline, "Native command did not become ready");
    await delay(20);
  }
  const cancelledAt = Date.now();
  abort.abort();
  assert.equal(JSON.parse(await running).stopped, true);
  assert.ok(Date.now() - cancelledAt < 10_000, "Native command tree did not stop promptly");
} finally {
  abort.abort();
  rmSync(root, { recursive: true, force: true });
}
console.log("Native command execution and process-tree cancellation passed.");
