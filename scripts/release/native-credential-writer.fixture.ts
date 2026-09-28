import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectPrivatePath, securePrivatePath } from "@marea/private-filesystem";
import { writePrivateFileAtomically } from "../../apps/student/src/filesystem.boundary.js";

// Native integration fixture: no injected filesystem operations or mocked ACL verifier.
const root = await realpath(await mkdtemp(join(tmpdir(), "marea-native-credential-")));
const checks: string[] = [];
try {
  securePrivatePath(root, 0o700);
  assert.equal(inspectPrivatePath(root), "directory");
  const credential = join(root, "credential.json");
  for (const generation of ["initial", "replacement"]) {
    const value = JSON.stringify({ sessionToken: `synthetic-${generation}-credential` });
    // The real writer applies permissions while its temporary descriptor is open,
    // closes it, then renames over the existing destination on the second iteration.
    await writePrivateFileAtomically(credential, value);
    assert.equal(await readFile(credential, "utf8"), value, `${generation}: credential content`);
    assert.equal(inspectPrivatePath(credential), "file", `${generation}: private credential`);
    assert.equal(inspectPrivatePath(root), "directory", `${generation}: private parent`);
    assert.deepEqual(await readdir(root), ["credential.json"], `${generation}: no temporary files`);
    checks.push(`${generation}-content-private-permissions-and-no-temporaries`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
const receipt = JSON.stringify({
  scenario: "native-private-credential-writer",
  platform: process.platform,
  architecture: process.arch,
  runtime: `Bun ${Bun.version}`,
  permissionVerification:
    process.platform === "win32" ? "native-owner-SID-and-DACL" : "owner-and-mode",
  checks,
});
const output = process.argv[2];
if (output !== undefined) await writeFile(resolve(output), `${receipt}\n`);
process.stdout.write(`${receipt}\n`);
