/* global Bun, console, process */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureSource } from "./evidence.mjs";

assert.equal(process.platform, "darwin", "This bounded disk-image fixture is macOS-only");
const expectedBun = JSON.parse(readFileSync("package.json", "utf8")).engines.bun;
assert.equal(Bun.version, expectedBun);
const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-resilience-os-enospc-")));
const report = resolve("reports/resilience/enospc.json");
mkdirSync(dirname(report), { recursive: true });
const mountpoint = join(root, "mounted");
const image = join(root, "bounded.dmg");
const binary = join(root, "probe");
const hostGeometry = statfsSync(root);
assert.ok(
  hostGeometry.bavail * hostGeometry.bsize > 512 * 1024 * 1024,
  "Leave ample host space for the bounded image and compiled fixture",
);
const startedAt = new Date().toISOString();
const start = Date.now();
const commands = [];
let mounted = false;
let attachAttempted = false;
let attachCompleted = false;
let cleanupUncertain = false;
const nonce = randomUUID();
let imageBytes;
let result;
let failure;
let source;
const run = (command, args, timeout = 120000) => {
  const began = Date.now();
  const output = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 2000000 });
  commands.push({
    command,
    args,
    durationMs: Date.now() - began,
    status: output.status,
    signal: output.signal,
  });
  assert.equal(output.status, 0, `${command}: ${output.stderr}`);
  return output.stdout;
};
try {
  assert.equal(run("bun", ["--version"]).trim(), expectedBun);
  source = captureSource(report);
  run("bun", ["build", "tests/resilience/enospc-probe.mjs", "--compile", "--outfile", binary]);
  source.assertUnchanged();
  run("hdiutil", [
    "create",
    "-size",
    "32m",
    "-type",
    "UDIF",
    "-fs",
    "HFS+",
    "-volname",
    "MareaResilienceDisposable",
    "-nospotlight",
    image,
  ]);
  imageBytes = statSync(image).size;
  assert.ok(imageBytes <= 40 * 1024 * 1024, "Image container must remain bounded");
  mkdirSync(mountpoint, { mode: 0o700 });
  attachAttempted = true;
  run("hdiutil", ["attach", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint, image]);
  mounted = true;
  attachCompleted = true;
  const volume = statfsSync(mountpoint);
  assert.ok(
    volume.blocks * volume.bsize <= 40 * 1024 * 1024,
    "Mount must be the small image, never the host filesystem",
  );
  writeFileSync(join(mountpoint, ".marea-resilience-disposable-volume"), nonce, { mode: 0o600 });
  result = JSON.parse(run(binary, [mountpoint, nonce], 60000));
  assert.ok(statSync(image).size <= 40 * 1024 * 1024);
} catch (error) {
  failure = { name: error.name, message: error.message };
} finally {
  if (mounted) {
    try {
      run("hdiutil", ["detach", mountpoint], 30000);
      mounted = false;
    } catch {
      try {
        const stillMounted = statfsSync(mountpoint);
        assert.ok(
          stillMounted.blocks * stillMounted.bsize <= 40 * 1024 * 1024,
          "Never force-detach a path that now resolves to the host filesystem",
        );
        assert.equal(
          readFileSync(join(mountpoint, ".marea-resilience-disposable-volume"), "utf8"),
          nonce,
        );
        run("hdiutil", ["detach", "-force", mountpoint], 30000);
        mounted = false;
      } catch (error) {
        cleanupUncertain = true;
        failure = {
          name: error.name,
          message: `Owned disposable volume remains mounted at ${mountpoint}: ${error.message}`,
        };
      }
    }
  }
  cleanupUncertain ||= attachAttempted && !attachCompleted;
  const receipt = {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    runtime: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    sourceManifestSha256: source?.sha256,
    sourceFiles: source?.files,
    binarySha256: existsSync(binary)
      ? createHash("sha256").update(readFileSync(binary)).digest("hex")
      : null,
    probeSourceSha256: createHash("sha256")
      .update(readFileSync("tests/resilience/enospc-probe.mjs"))
      .digest("hex"),
    imageBytes,
    filesystem: "HFS+ in private 32MiB UDIF image",
    commands,
    result,
    failure,
    detached: !mounted && !cleanupUncertain,
    cleanupUncertain,
    retainedWorkspace: mounted || cleanupUncertain ? root : null,
    passed: !failure && !mounted && !cleanupUncertain,
    boundary:
      "Real filesystem ENOSPC and SQLite transactional recovery on a bounded macOS disk image; no host-volume exhaustion and no cross-platform claim",
  };
  writeFileSync(report, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  if (!mounted && !cleanupUncertain) rmSync(root, { recursive: true, force: true });
}
assert.ok(
  !failure && !mounted && !cleanupUncertain,
  "See the durable ENOSPC receipt for the exact failure and cleanup state",
);
