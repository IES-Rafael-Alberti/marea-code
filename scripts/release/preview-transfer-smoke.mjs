import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { downloadPreview } from "./preview-download.boundary.ts";
import { verifyFiles } from "./files.boundary.ts";
import { verifySignature } from "./install.boundary.ts";
import { manifestSchema } from "./manifest.ts";

// Exercise the real native inventory and verifier with compressed transport and cache misses.
const source = realpathSync(resolve(process.argv[2]));
const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")),
);
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-native-transfer-")));
const suffix = process.platform === "win32" ? ".exe" : "";
const programs = [`marea-install${suffix}`, `cosign${suffix}`];
const files = new Map(manifest.files.map((file) => [`sha256-${file.sha256}.gz`, file.path]));
const repository = process.env.GITHUB_REPOSITORY ?? "IES-Rafael-Alberti/marea-code";
const settings = { format: 1, repository, component: manifest.component, channel: "preview" };
let requested = [];
let transferred = 0;
const fetch = async (url) => {
  const name = new globalThis.URL(url).pathname.split("/").at(-1);
  if (name.endsWith(".manifest.json"))
    return new globalThis.Response(readFileSync(join(source, "manifest.json")));
  if (name.endsWith(".sigstore.json"))
    return new globalThis.Response(readFileSync(join(source, "manifest.sigstore.json")));
  assert.ok(files.has(name), `Unexpected raw download: ${name}`);
  requested.push(files.get(name));
  const body = gzipSync(readFileSync(join(source, files.get(name))));
  transferred += body.length;
  return new globalThis.Response(body);
};
const verify = (inventory, bundle, identity) =>
  verifySignature(inventory, bundle, identity, join(source, `cosign${suffix}`));
async function download(name, reuseDirectory) {
  const destination = join(scratch, name);
  mkdirSync(destination, { mode: 0o700 });
  requested = [];
  await downloadPreview(settings, manifest.version, manifest.target, destination, {
    fetch,
    verify,
    reuseDirectory,
  });
  verifyFiles(destination, manifest);
  return destination;
}
try {
  // Preserve the platform's original temporary base, including macOS's /var alias.
  const bootstrap = join(tmpdir(), basename(scratch), "bootstrap");
  mkdirSync(bootstrap);
  for (const name of programs) {
    cpSync(join(source, name), join(bootstrap, name));
    transferred += gzipSync(readFileSync(join(source, name))).length;
  }
  const installed = await download("fresh", bootstrap);
  assert.equal(requested.length, manifest.files.length - programs.length);
  for (const name of programs) assert.ok(!requested.includes(name), "Bootstrap download repeated");
  const initialBytes = transferred;
  const unchanged = await download("unchanged", installed);
  assert.deepEqual(requested, [], "Unchanged files must not be downloaded again");
  writeFileSync(join(unchanged, programs[0]), "damaged cached installer");
  await download("repaired", unchanged);
  assert.deepEqual(requested, [programs[0]], "Only the damaged cached artifact needs downloading");
  process.stdout.write(
    `Native ${manifest.component}: compressed installation ${(initialBytes / 1048576).toFixed(1)} MiB; bootstrap reused, unchanged update downloaded 0 artifacts, damaged cache repaired.\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
