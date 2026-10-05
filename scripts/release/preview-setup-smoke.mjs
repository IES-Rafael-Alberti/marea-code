import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { securePrivatePath } from "@marea/private-filesystem";
import { scaffoldServer, provisionServer } from "./preview-setup.boundary.ts";
import {
  activatePreviewServer,
  assertPreviewServerReady,
  updateJournal,
} from "./preview-server-update.boundary.ts";
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.ts";
import {
  startCompiledHost,
  stopCompiledHost,
} from "../../apps/teacher-server/smoke/compiled-host-process.ts";

const release = realpathSync(resolve(process.argv[2]));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-preview-setup-")));
securePrivatePath(scratch, 0o700);
const root = join(scratch, "installation");
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const answers = {
  center: "Preview school",
  classroom: "Preview class",
  teacher: "Preview teacher",
  login: "teacher",
  origin: `http://127.0.0.1:${port}`,
  port,
};
const password = "synthetic-preview-password";
const run = (binary, args, input) => {
  const result = spawnSync(binary, args, { input, encoding: "utf8", timeout: 120000 });
  assert.equal(
    result.status,
    0,
    `Synthetic setup failed: ${args.slice(2, 4).join(" ")} ${result.stderr}`,
  );
  return result.stdout;
};
// The installer makes dashboard files private. This direct binary smoke starts
// from the CI build tree, so reproduce those permissions before provisioning.
function privateDashboard(directory) {
  securePrivatePath(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) privateDashboard(path);
    else securePrivatePath(path, 0o600);
  }
}
try {
  privateDashboard(join(release, "dashboard"));
  scaffoldServer(root, release, "0.1.0-preview.1", answers);
  provisionServer(root, release, answers, password, run);
  assert.ok(
    readFileSync(join(root, "config/server-settings.json"), "utf8").includes("user:teacher"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  if (process.platform === "win32") {
    run("pwsh", [
      "-NoProfile",
      "-File",
      resolve(import.meta.dirname, "conpty-smoke.ps1"),
      "-ServerExecutable",
      join(release, "marea-teacher.exe"),
      "-Installation",
      root,
      "-ReleaseId",
      "release:preview",
    ]);
  } else {
    const host = await startCompiledHost(
      join(release, `marea-teacher${suffix}`),
      root,
      "release:preview",
    );
    try {
      const dashboard = await globalThis.fetch(`${host.origin}/dashboard/`);
      assert.equal(dashboard.status, 200);
      const response = await globalThis.fetch(`${host.origin}/v1/capabilities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "request:preview",
          clientVersion: "0.1.0-preview.1",
          supportedProtocolVersions: ["0.1"],
        }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).serverVersion, "0.1.0-preview.1");
      const login = await globalThis.fetch(`${host.origin}/api/v1/dashboard/session/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: host.origin },
        body: JSON.stringify({
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: "request:preview-login",
          credentials: { login: "teacher", password },
        }),
      });
      assert.equal(login.status, 200, "Provisioned teacher can sign in");
    } finally {
      await stopCompiledHost(host);
    }
  }
  const held = acquireInstallation(root);
  try {
    await assert.rejects(
      activatePreviewServer(root, release, "0.1.0-preview.2", () => Promise.resolve()),
    );
  } finally {
    held.release();
  }
  await activatePreviewServer(root, release, "0.1.0-preview.2", () => Promise.resolve());
  assert.equal(
    JSON.parse(readFileSync(join(root, "config/teacher-host.json"), "utf8")).serverVersion,
    "0.1.0-preview.2",
  );
  assert.equal(assertPreviewServerReady(root), "release:preview");
  await assert.rejects(
    activatePreviewServer(root, release, "0.1.0-preview.3", () =>
      Promise.reject(new Error("synthetic interruption")),
    ),
  );
  assert.throws(() => assertPreviewServerReady(root), /interrupted update/);
  const journal = JSON.parse(readFileSync(join(root, "state", updateJournal), "utf8"));
  const input = join(root, "work", "restore-preview.json");
  writeFileSync(
    input,
    JSON.stringify({ bundlePath: journal.backup, destinationRoot: join(scratch, "restored") }),
    { mode: 0o600 },
  );
  const restored = JSON.parse(
    run(join(release, `marea-operations${suffix}`), [
      "--installation",
      root,
      "backup",
      "restore",
      "--input",
      input,
    ]),
  );
  assert.equal(restored.state, "restored");
  process.stdout.write(
    "Preview setup passed: offline CLIs, private state, teacher provisioning, version negotiation, busy update refusal, upgrade, interrupted update and deletion-aware restore.\n",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
