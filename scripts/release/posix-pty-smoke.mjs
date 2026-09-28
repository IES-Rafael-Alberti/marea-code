import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnPty } from "../../test-support/terminal/pty.ts";

assert.notEqual(process.platform, "win32", "Windows must use the native ConPTY probe");
const executable = realpathSync(resolve(process.argv[2]));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-native-tui-")));
try {
  for (const [scenario, expectedExit] of [
    ["quit", 0],
    ["copy-then-quit", 0],
    ["signal-interrupt", 130],
  ]) {
    process.stdout.write(`PTY scenario ${scenario} started.\n`);
    const terminal = spawnPty({
      command: executable,
      currentDirectory: scratch,
      environment: process.env,
    });
    try {
      await terminal.waitForText("Marea", 15000);
      await terminal.waitForQuiet(200, 15000);
      if (scenario === "signal-interrupt") terminal.kill("SIGINT");
      else {
        if (scenario === "copy-then-quit") {
          terminal.write("\u0003");
          await assert.rejects(terminal.waitForExit(300), /Timed out/u);
        }
        terminal.write("q");
      }
      const result = await terminal.waitForExit(15000);
      assert.equal(result.exitCode, expectedExit, terminal.transcript());
      assert.ok(
        terminal.transcript().includes("[?1049l"),
        "OpenTUI must restore the alternate screen",
      );
    } catch (error) {
      process.stderr.write(terminal.transcript());
      throw error;
    } finally {
      terminal.kill();
    }
  }
  process.stdout.write(
    "Native OpenTUI render/quit/Ctrl+C-copy/SIGINT/terminal restore passed outside source checkout.\n",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
