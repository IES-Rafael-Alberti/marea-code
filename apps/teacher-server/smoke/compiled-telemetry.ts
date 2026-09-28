/** Combined production-catalog acceptance with temporary trusted TLS collectors. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marea-telemetry-release-"));
try {
  const certificate = join(directory, "collector.pem");
  const key = join(directory, "collector.key");
  const config = join(directory, "certificate.cnf");
  writeFileSync(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    { mode: 0o600 },
  );
  const certificateResult = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      certificate,
      "-config",
      config,
    ],
    { encoding: "utf8" },
  );
  assert.equal(certificateResult.status, 0, certificateResult.stderr);
  const binary = join(directory, "acceptance");
  const build = spawnSync(
    "bun",
    [
      "build",
      resolve(import.meta.dir, "telemetry-release.fixture.ts"),
      "--compile",
      "--outfile",
      binary,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [certificate, key], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  process.stdout.write(run.stdout);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
