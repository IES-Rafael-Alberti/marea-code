import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";

import {
  compileInstallationExecutables,
  freeLoopbackPort,
} from "../../test-support/platform/installation.js";

const COMMANDS = "tests/fixtures/operator-lifecycle.sh";
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "marea-guide-")));
chmodSync(workspace, 0o700);
const release = join(workspace, "release");

beforeAll(() => {
  const build = spawnSync("bun", ["run", "--cwd", "apps/dashboard", "build"], {
    encoding: "utf8",
    timeout: 180_000,
  });
  expect(build.status, build.stderr).toBe(0);
  compileInstallationExecutables(join(release, "bin"));
  cpSync("apps/dashboard/dist", join(release, "dashboard"), { recursive: true });
  cpSync("content/skills", join(release, "skills"), { recursive: true });
}, 300_000);

afterAll(() => {
  // A host left running by a failed step still records its process in the installation lock.
  const lock = join(workspace, "installation", ".marea-installation.lock");
  if (existsSync(lock)) {
    const { pid } = z.object({ pid: z.number() }).parse(JSON.parse(readFileSync(lock, "utf8")));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process has already exited.
    }
  }
  rmSync(workspace, { recursive: true, force: true });
});

describe("Operator lifecycle", () => {
  it("installs, operates, backs up, upgrades, restores and deletes using the command fixture", async () => {
    const root = join(workspace, "installation");
    const restores = join(workspace, "restores");
    const port = await freeLoopbackPort();
    const commands = readFileSync(COMMANDS, "utf8");
    expect(commands.split("\n").length).toBeGreaterThan(100);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", commands], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 240_000,
      env: {
        ...process.env,
        MAREA_RELEASE: release,
        MAREA_ROOT: root,
        MAREA_NEW_ROOT: join(workspace, "moved"),
        MAREA_RESTORE_PARENT: restores,
        MAREA_PORT: String(port),
        OPENROUTER_API_KEY: "synthetic-guide-openrouter-key",
        ADMIN_PASSWORD: "synthetic-guide-admin-password",
      },
      input: "",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(readFileSync(join(root, "work", "host.log"), "utf8")).toContain(
      `Teacher host ready at http://127.0.0.1:${String(port)}`,
    );
    expect(existsSync(join(root, "work", "physics-exchange.json"))).toBe(true);
    expect(existsSync(join(restores, "restored-nightly", "database.sqlite"))).toBe(true);
    expect(readFileSync(join(workspace, "moved", "work", "host.log"), "utf8")).toContain(
      `Teacher host ready at http://127.0.0.1:${String(port)}`,
    );
    const database = new DatabaseSync(join(root, "marea.sqlite"), { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT COUNT(*) AS total FROM marea_users WHERE id = 'user:leaver'")
          .get(),
      ).toEqual({ total: 0 });
      expect(
        database
          .prepare(
            "SELECT capability FROM marea_center_memberships WHERE center_id = 'center:north' AND user_id = 'user:ada'",
          )
          .get(),
      ).toEqual({ capability: "administrator" });
    } finally {
      database.close();
    }
  }, 300_000);
});
