import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { manifestSchema, selectRelease, sha256, signingIdentity } from "./manifest.js";
import { ordinaryFiles, verifyFiles } from "./files.boundary.js";
import {
  installRelease,
  privateDirectory,
  prepareState,
  readActivation,
  uninstallRelease,
  type InstallPorts,
} from "./install.boundary.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-release-test-")));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "marea"), "binary");
  const manifest = {
    format: 1,
    version: "1.2.3",
    component: "student",
    target: `${process.platform}-${process.arch}`,
    bun: "1.4.2",
    opentui: "0.5.10",
    commit: "a".repeat(40),
    files: [{ path: "marea", sha256: sha256(Buffer.from("binary")), executable: true }],
  };
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(source, "manifest.sigstore.json"), "{}");
  const request = {
    source,
    root: join(root, "programs"),
    version: "1.2.3",
    component: "student",
    repository: "owner/repo",
    ref: "refs/heads/main",
  };
  const ports: InstallPorts = {
    verifySignature: vi.fn(),
    privateDirectory,
    withOfflineBackup: <T>(operation: () => Promise<T>) => operation(),
  };
  return { root, source, manifest, request, ports };
}
async function serverUpdateFixture() {
  const f = fixture();
  f.manifest.component = "server";
  writeFileSync(join(f.source, "manifest.json"), JSON.stringify(f.manifest));
  const request = { ...f.request, component: "server" };
  await installRelease(request, f.ports);
  f.manifest.version = "1.2.4";
  writeFileSync(join(f.source, "manifest.json"), JSON.stringify(f.manifest));
  return { f, request };
}
it("reactivates only explicitly requested, completely reverified student programs", async () => {
  const f = fixture();
  await installRelease(f.request, f.ports);
  const previousManifest = JSON.stringify(f.manifest);
  f.manifest.version = "1.2.4";
  writeFileSync(join(f.source, "manifest.json"), JSON.stringify(f.manifest));
  await installRelease({ ...f.request, version: "1.2.4" }, f.ports);
  writeFileSync(join(f.source, "manifest.json"), previousManifest);
  await installRelease({ ...f.request, reuseVerifiedStudent: true }, f.ports);
  expect(readActivation(f.request.root)).toEqual({
    current: "student-1.2.3",
    previous: "student-1.2.4",
  });
  const retainedProgram = join(f.request.root, "student-1.2.3", "marea");
  chmodSync(retainedProgram, 0o700);
  writeFileSync(retainedProgram, "tampered");
  await expect(
    installRelease({ ...f.request, reuseVerifiedStudent: true }, f.ports),
  ).rejects.toThrow("checksum mismatch");
  writeFileSync(retainedProgram, "binary");
  const retained = join(f.request.root, "student-1.2.3", "manifest.json");
  chmodSync(retained, 0o600);
  writeFileSync(retained, `${previousManifest}\n`);
  await expect(
    installRelease({ ...f.request, reuseVerifiedStudent: true }, f.ports),
  ).rejects.toThrow("Retained release manifest mismatch");
  const server = await serverUpdateFixture();
  writeFileSync(
    join(server.f.source, "manifest.json"),
    JSON.stringify({ ...server.f.manifest, version: "1.2.3" }),
  );
  await expect(
    installRelease({ ...server.request, reuseVerifiedStudent: true }, server.f.ports),
  ).rejects.toThrow("Immutable release already exists");
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("binds explicit component, version, native platform and exact workflow identity", () => {
  const f = fixture();
  expect(selectRelease(f.manifest, "1.2.3", "student", f.manifest.target)).toEqual(f.manifest);
  for (const selection of [
    ["1.2.4", "student", f.manifest.target],
    ["1.2.3", "server", f.manifest.target],
    ["1.2.3", "student", "other"],
  ])
    expect(() => selectRelease(f.manifest, ...(selection as [string, string, string]))).toThrow();
  expect(signingIdentity("owner/repo", "refs/tags/v1.2.3")).toBe(
    "https://github.com/owner/repo/.github/workflows/native-release-candidate.yml@refs/tags/v1.2.3",
  );
  expect(() => signingIdentity("owner/repo.*", "refs/heads/main")).toThrow();
  expect(() => signingIdentity("owner/repo", "main")).toThrow();
});
it("rejects traversal, Windows aliases, case collisions and file-directory collisions", () => {
  const f = fixture();
  for (const path of [
    "../bad",
    "/absolute",
    "C:/absolute",
    "a\\b",
    "NUL",
    "a/CON.txt",
    "a.",
    "./file",
    "x:stream",
  ])
    expect(
      manifestSchema.safeParse({ ...f.manifest, files: [{ ...f.manifest.files[0], path }] })
        .success,
    ).toBe(false);
  for (const paths of [
    ["A", "a"],
    ["a", "a/b"],
  ])
    expect(
      manifestSchema.safeParse({
        ...f.manifest,
        files: paths.map((path) => ({ ...f.manifest.files[0], path })),
      }).success,
    ).toBe(false);
  expect(
    manifestSchema.safeParse({ ...f.manifest, component: "server", target: "win32-arm64" }).success,
  ).toBe(false);
});
it("verifies closed inventory and contents, rejecting links", () => {
  const f = fixture();
  const manifest = manifestSchema.parse(f.manifest);
  verifyFiles(f.source, manifest);
  writeFileSync(join(f.source, "extra"), "x");
  expect(() => {
    verifyFiles(f.source, manifest);
  }).toThrow("inventory");
  rmSync(join(f.source, "extra"));
  writeFileSync(join(f.source, "marea"), "tampered");
  expect(() => {
    verifyFiles(f.source, manifest);
  }).toThrow("checksum");
  symlinkSync(join(f.source, "marea"), join(f.source, "link"));
  expect(() => ordinaryFiles(f.source)).toThrow("Symlink");
  rmSync(join(f.source, "link"));
  linkSync(join(f.source, "marea"), join(f.source, "hardlink"));
  expect(() => ordinaryFiles(f.source)).toThrow("Nonregular");
});
it("activates after verification, keeps previous version, and uninstalls without deleting data", async () => {
  const f = fixture();
  await installRelease(f.request, f.ports);
  expect(readActivation(f.request.root)).toEqual({ current: "student-1.2.3", previous: null });
  writeFileSync(join(f.root, "credentials"), "retained");
  f.manifest.version = "1.2.4";
  writeFileSync(join(f.source, "manifest.json"), JSON.stringify(f.manifest));
  await installRelease({ ...f.request, version: "1.2.4" }, f.ports);
  expect(readActivation(f.request.root)).toEqual({
    current: "student-1.2.4",
    previous: "student-1.2.3",
  });
  expect(readFileSync(join(f.request.root, "student-1.2.3", "marea"), "utf8")).toBe("binary");
  await uninstallRelease(f.request.root, "student", f.ports);
  expect(readActivation(f.request.root)).toBe(null);
  expect(readFileSync(join(f.root, "credentials"), "utf8")).toBe("retained");
});
it("signature failure prevents activation, private roots and immutable versions are enforced", async () => {
  const f = fixture();
  f.ports.verifySignature = () => {
    throw new Error("bad signature");
  };
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("signature");
  expect(readActivation(f.request.root)).toBe(null);
  f.ports.verifySignature = vi.fn();
  await installRelease(f.request, f.ports);
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("Immutable");
  chmodSync(f.request.root, 0o755);
  expect(() => {
    privateDirectory(f.request.root);
  }).toThrow("private");
});
it("failed offline backup leaves server pointer unchanged", async () => {
  const { f, request } = await serverUpdateFixture();
  f.ports.withOfflineBackup = () => {
    throw new Error("server busy or backup failed");
  };
  await expect(installRelease({ ...request, version: "1.2.4" }, f.ports)).rejects.toThrow(
    "backup failed",
  );
  expect(readActivation(request.root)?.current).toBe("server-1.2.3");
  await expect(uninstallRelease(request.root, "server", f.ports)).rejects.toThrow("backup failed");
});
it("rejects invalid activation records and noncanonical roots", async () => {
  const f = fixture();
  expect(() => ordinaryFiles(join(f.source, "marea"))).toThrow("Noncanonical");
  expect(() => {
    privateDirectory(join(f.source, "marea"));
  }).toThrow("canonical");
  const alias = join(f.root, "alias");
  symlinkSync(f.source, alias);
  expect(() => ordinaryFiles(alias)).toThrow("Noncanonical");
  expect(() => {
    privateDirectory(alias);
  }).toThrow("canonical");
  await installRelease(f.request, f.ports);
  const pointer = join(f.request.root, "active.json");
  for (const value of [
    { current: "../escape", previous: null },
    { current: 1, previous: null },
    { current: "student-1.2.3" },
  ]) {
    writeFileSync(pointer, JSON.stringify(value));
    expect(() => readActivation(f.request.root)).toThrow("pointer");
  }
  rmSync(pointer);
  mkdirSync(pointer);
  expect(() => readActivation(f.request.root)).toThrow("record");
  rmSync(pointer, { recursive: true });
  writeFileSync(pointer, "{}");
  linkSync(pointer, join(f.root, "alias-pointer"));
  expect(() => readActivation(f.request.root)).toThrow("record");
});
it("copies nested nonexecutable assets and refuses malformed signature metadata", async () => {
  const f = fixture();
  mkdirSync(join(f.source, "assets"));
  writeFileSync(join(f.source, "assets", "index.html"), "html");
  f.manifest.files.push({
    path: "assets/index.html",
    sha256: sha256(Buffer.from("html")),
    executable: false,
  });
  writeFileSync(join(f.source, "manifest.json"), JSON.stringify(f.manifest));
  await installRelease(f.request, f.ports);
  expect(readFileSync(join(f.request.root, "student-1.2.3", "assets", "index.html"), "utf8")).toBe(
    "html",
  );
  await expect(uninstallRelease(f.request.root, "server", f.ports)).rejects.toThrow("Component");
  await uninstallRelease(f.request.root, "student", f.ports);
  await uninstallRelease(f.request.root, "student", f.ports);
  const bundle = join(f.source, "manifest.sigstore.json");
  rmSync(bundle);
  mkdirSync(bundle);
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("metadata");
  rmSync(bundle, { recursive: true });
  writeFileSync(bundle, "{}");
  linkSync(bundle, join(f.root, "bundle-link"));
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("metadata");
  rmSync(join(f.root, "bundle-link"));
  writeFileSync(bundle, Buffer.alloc(8_388_609));
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("metadata");
});
it("serializes activation and uninstall and executes server backup before switching", async () => {
  const { f, request } = await serverUpdateFixture();
  f.ports.withOfflineBackup = async (operation) => {
    expect(readActivation(request.root)?.current).toBe("server-1.2.3");
    await expect(uninstallRelease(request.root, "server", f.ports)).rejects.toThrow();
    return operation();
  };
  await installRelease({ ...request, version: "1.2.4" }, f.ports);
  expect(readActivation(request.root)?.previous).toBe("server-1.2.3");
  f.ports.withOfflineBackup = (operation) => operation();
  await uninstallRelease(request.root, "server", f.ports);
  expect(readActivation(request.root)).toBe(null);
});

it("provisions only new or empty private state directories without changing data", () => {
  const f = fixture();
  const state = join(f.root, "state");
  prepareState(state);
  privateDirectory(state);
  prepareState(state);
  writeFileSync(join(state, "credential"), "retain");
  expect(() => {
    prepareState(state);
  }).toThrow("empty");
  expect(readFileSync(join(state, "credential"), "utf8")).toBe("retain");
  const alias = join(f.root, "alias-state");
  symlinkSync(state, alias);
  expect(() => {
    prepareState(alias);
  }).toThrow("canonical");
  expect(() => {
    prepareState(join(alias, "new"));
  }).toThrow("canonical");
});
