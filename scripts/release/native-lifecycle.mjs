import process from "node:process";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { securePrivatePath } from "@marea/private-filesystem";
import { teacherHostInstallation } from "../../apps/teacher-server/src/platform/teacher-host/teacher-host.fixture.ts";
import {
  startCompiledHost,
  stopCompiledHost,
} from "../../apps/teacher-server/smoke/compiled-host-process.ts";
import { acquireInstallation } from "../../apps/teacher-server/src/platform/operator-cli/installation-lock.ts";

const source = realpathSync(resolve(process.argv[2]));
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-native-release-")));
securePrivatePath(scratch, 0o700);
const programs = join(scratch, "programs");
const suffix = process.platform === "win32" ? ".exe" : "";
const conptyScript = resolve(import.meta.dirname, "conpty-smoke.ps1");
const installer = join(source, `marea-install${suffix}`);
const repository = process.env.GITHUB_REPOSITORY;
const ref = process.env.GITHUB_REF;
assert.ok(repository && ref, "Native lifecycle requires the actual signed CI workflow identity");
const identity = `https://github.com/${repository}/.github/workflows/native-release-candidate.yml@${ref}`;
const run = (binary, args, expected = 0) => {
  const result = spawnSync(binary, args, { cwd: scratch, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, expected, `${binary}: ${result.stderr}`);
  return result.stdout;
};
const state = manifest.component === "server" ? teacherHostInstallation({ teacher: false }) : null;
const stateArgs = state ? ["--installation", state.root] : [];
const selected = (action, candidate, version) => [
  action,
  manifest.component,
  "--root",
  programs,
  "--source",
  candidate,
  "--version",
  version,
  "--repository",
  repository,
  "--ref",
  ref,
  ...stateArgs,
];
const status = () => JSON.parse(run(installer, ["status", manifest.component, "--root", programs]));
const originalDirectory = process.cwd();
process.chdir(scratch);
try {
  run(installer, selected("install", source, manifest.version));
  assert.equal(status().current, `${manifest.component}-${manifest.version}`);
  if (manifest.component === "student") {
    assert.match(
      run(join(programs, status().current, `marea${suffix}`), ["--lang", "en", "--help"]),
      /Usage: marea/u,
    );
  }
  if (state) {
    const release = join(programs, status().current);
    const adminInput = state.work("native-center.json", {
      centerId: "center:native",
      displayName: "Native release probe",
      expectedVersion: null,
    });
    run(join(release, `marea-admin${suffix}`), [
      "--installation",
      state.root,
      "center",
      "create",
      "--input",
      adminInput,
    ]);
    state.writeHost({ ...state.host, dashboardDistPath: join(release, "dashboard") });
    const hostBinary = join(release, `marea-teacher${suffix}`);
    if (process.platform === "win32") {
      run("pwsh", [
        "-NoProfile",
        "-File",
        conptyScript,
        "-ServerExecutable",
        hostBinary,
        "-Installation",
        state.root,
      ]);
    } else {
      const host = await startCompiledHost(hostBinary, state.root, state.host.releaseId);
      try {
        const response = await globalThis.fetch(`${host.origin}/dashboard/`, {
          headers: { host: "teacher.test" },
        });
        assert.equal(
          response.status,
          200,
          "Installed server serves matching packaged dashboard assets",
        );
      } finally {
        await stopCompiledHost(host);
      }
    }
  }
  const next = `${manifest.version}-native-smoke`;
  const copy = join(scratch, "next");
  cpSync(source, copy, { recursive: true });
  writeFileSync(
    join(copy, "manifest.json"),
    JSON.stringify({ ...manifest, version: next }, null, 2),
  );
  run("cosign", [
    "sign-blob",
    "--yes",
    "--bundle",
    join(copy, "manifest.sigstore.json"),
    join(copy, "manifest.json"),
  ]);
  run("cosign", [
    "verify-blob",
    "--bundle",
    join(copy, "manifest.sigstore.json"),
    "--certificate-identity",
    identity,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    join(copy, "manifest.json"),
  ]);
  if (state) {
    const held = acquireInstallation(state.root);
    try {
      const refused = spawnSync(installer, selected("update", copy, next), {
        encoding: "utf8",
        timeout: 120000,
      });
      assert.notEqual(refused.status, 0, "A live installation owner must block update");
      assert.equal(status().current, `${manifest.component}-${manifest.version}`);
    } finally {
      held.release();
    }
  }
  run(installer, selected("update", copy, next));
  assert.deepEqual(status(), {
    current: `${manifest.component}-${next}`,
    previous: `${manifest.component}-${manifest.version}`,
  });
  assert.ok(
    existsSync(join(programs, `${manifest.component}-${manifest.version}`)),
    "Previous immutable programs retained",
  );
  if (state) {
    const backups = readdirSync(join(state.root, "backups"));
    assert.ok(backups.length > 0);
    const input = join(state.root, "work", "restore.json");
    const restored = join(scratch, "restored");
    writeFileSync(
      input,
      JSON.stringify({
        bundlePath: join(state.root, "backups", backups[0]),
        destinationRoot: restored,
      }),
      { mode: 0o600 },
    );
    securePrivatePath(input, 0o600);
    const operations = join(programs, status().current, `marea-operations${suffix}`);
    const result = JSON.parse(
      run(operations, ["--installation", state.root, "backup", "restore", "--input", input]),
    );
    assert.equal(
      result.state,
      "restored",
      "Existing deletion-aware restore must succeed into isolated destination",
    );
  }
  run(installer, ["uninstall", manifest.component, "--root", programs, ...stateArgs]);
  assert.equal(status(), null);
  if (state) assert.ok(existsSync(state.databasePath), "Uninstall retains data");
  process.stdout.write(
    `${JSON.stringify({ component: manifest.component, platform: process.platform, architecture: process.arch, bun: process.versions.bun, install: "passed", busyUpdate: state ? "passed" : "not-applicable", update: "passed", restore: state ? "passed" : "not-applicable", uninstall: "passed" })}\n`,
  );
} finally {
  process.chdir(originalDirectory);
  rmSync(scratch, { recursive: true, force: true });
  if (state) rmSync(state.root, { recursive: true, force: true });
}
