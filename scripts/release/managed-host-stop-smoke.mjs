import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnPty } from "../../test-support/terminal/pty.ts";

/** A real terminal signals both the managed launcher and its child in the foreground group. */
export async function verifyManagedHostStop(binary, root, releaseId) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-host-signals-")));
  try {
    const entry = join(scratch, "launcher.ts");
    writeFileSync(
      entry,
      `import {runForeground} from ${JSON.stringify(resolve("scripts/release/preview-process.boundary.ts"))};\nprocess.exitCode = await runForeground(process.argv[2], process.argv.slice(3), process.env);\n`,
    );
    const launcher = join(scratch, "launcher");
    execFileSync("bun", ["build", entry, "--compile", "--outfile", launcher], { stdio: "pipe" });
    for (const interrupt of ["\u0003", "\u0003\u0003", "\u0003"]) {
      const terminal = spawnPty({
        command: launcher,
        arguments: [binary, "--installation", root, "--release", releaseId, "--allow-http"],
        currentDirectory: scratch,
        environment: process.env,
      });
      try {
        await terminal.waitForText("Teacher host ready at");
        terminal.write(interrupt);
        const result = await terminal.waitForExit(30000);
        assert.equal(result.exitCode, 0, terminal.transcript());
        assert.ok(terminal.transcript().includes("Teacher host stopped."));
        assert.equal(
          JSON.parse(readFileSync(join(root, "state/host-status.json"), "utf8")).status,
          "stopped",
        );
      } finally {
        terminal.kill();
      }
    }
    process.stdout.write("Managed server Ctrl+C and repeated Ctrl+C drain and restart cleanly.\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
