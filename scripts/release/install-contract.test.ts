import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@marea/private-filesystem", async (original) => {
  const actual = await original<typeof import("@marea/private-filesystem")>();
  return {
    ...actual,
    securePrivatePath: vi.fn(actual.securePrivatePath),
    inspectPrivatePath: vi.fn(actual.inspectPrivatePath),
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    cpSync: vi.fn(actual.cpSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
import { inspectPrivatePath, securePrivatePath } from "@marea/private-filesystem";
import {
  installRelease,
  privateDirectory,
  prepareState,
  readActivation,
  uninstallRelease,
  type InstallPorts,
} from "./install.boundary.js";
import { sha256 } from "./manifest.js";
const created: string[] = [];
function fixture(selected: "student" | "server" = "student") {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "release-contract-")));
  created.push(temp);
  const source = join(temp, "source");
  mkdirSync(source);
  const manifest = {
    format: 1,
    version: "1.2.3",
    component: selected,
    target: `${process.platform}-${process.arch}`,
    bun: "1.4.0",
    opentui: "0.5.10",
    commit: "a".repeat(40),
    files: [
      { path: "binary", sha256: sha256(Buffer.from("program")), executable: true },
      { path: "assets/index.html", sha256: sha256(Buffer.from("asset")), executable: false },
    ],
  };
  mkdirSync(join(source, "assets"));
  writeFileSync(join(source, "binary"), "program");
  writeFileSync(join(source, "assets/index.html"), "asset");
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(source, "manifest.sigstore.json"), "{}");
  const request = {
    source,
    root: join(temp, "programs"),
    version: "1.2.3",
    component: selected,
    repository: "owner/repo",
    ref: "refs/tags/v1.2.3",
  };
  const backup = vi.fn();
  const ports = {
    privateDirectory: vi.fn(privateDirectory),
    verifySignature: vi.fn<(manifest: string, bundle: string, identity: string) => void>(),
    withOfflineBackup: <T>(operation: () => Promise<T>): Promise<T> => {
      backup();
      return operation();
    },
  } satisfies InstallPorts;
  return { temp, source, manifest, request, ports, backup };
}
afterEach(() => {
  vi.clearAllMocks();
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("secures new roots, verifies private signature snapshots, and preserves immutable program modes", async () => {
  const f = fixture();
  f.ports.verifySignature = vi.fn((manifest: string, bundle: string, identity: string) => {
    expect(manifest).toMatch(/\/\.stage-[^/]+\/manifest\.json$/u);
    expect(bundle).toMatch(/\/\.stage-[^/]+\/manifest\.sigstore\.json$/u);
    expect(identity).toBe(
      "https://github.com/owner/repo/.github/workflows/native-release-candidate.yml@refs/tags/v1.2.3",
    );
    expect(lstatSync(manifest).mode & 0o777).toBe(0o600);
    expect(lstatSync(bundle).mode & 0o777).toBe(0o600);
    expect(readFileSync(bundle, "utf8")).toBe("{}");
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual(f.manifest);
    vi.mocked(readFileSync).mockClear();
  });
  await installRelease(f.request, f.ports);
  expect(securePrivatePath).toHaveBeenCalledExactlyOnceWith(f.request.root, 0o700);
  expect(f.ports.privateDirectory).toHaveBeenCalledExactlyOnceWith(f.request.root);
  expect(f.backup).not.toHaveBeenCalled();
  expect(closeSync).toHaveBeenCalledTimes(1);
  expect(cpSync).toHaveBeenCalledWith(
    join(f.source, "binary"),
    expect.stringMatching(/\/\.stage-[^/]+\/binary$/u),
    { recursive: false },
  );
  expect(readFileSync).toHaveBeenCalledWith(
    expect.stringMatching(/\/\.stage-[^/]+\/manifest\.json$/u),
    "utf8",
  );
  expect(writeFileSync).toHaveBeenCalledWith(
    expect.stringMatching(/\/\.stage-[^/]+\/manifest\.json$/u),
    expect.any(Buffer),
    { flag: "wx", mode: 0o600 },
  );
  expect(writeFileSync).toHaveBeenCalledWith(
    expect.stringMatching(/\/\.active-[^/]+\.json$/u),
    expect.any(String),
    { flag: "wx", mode: 0o600 },
  );
  const release = join(f.request.root, "student-1.2.3");
  expect(lstatSync(join(release, "binary")).mode & 0o777).toBe(0o500);
  expect(lstatSync(join(release, "assets/index.html")).mode & 0o777).toBe(0o400);
  expect(lstatSync(join(f.request.root, "active.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.request.root)).toEqual(["active.json", "student-1.2.3"]);
  await uninstallRelease(f.request.root, "student", f.ports);
  expect(f.ports.privateDirectory).toHaveBeenCalledTimes(2);
  expect(f.backup).not.toHaveBeenCalled();
  expect(closeSync).toHaveBeenCalledTimes(2);
  expect(existsSync(release)).toBe(false);
  expect(rmSync).toHaveBeenCalledWith(release, { recursive: true, force: true });
});
it("does not repair an existing root and treats OS privacy rejection as fatal", async () => {
  const f = fixture();
  mkdirSync(f.request.root, { mode: 0o700 });
  await installRelease(f.request, f.ports);
  expect(securePrivatePath).not.toHaveBeenCalled();
  const inspect = vi.mocked(inspectPrivatePath);
  inspect.mockReturnValueOnce(undefined);
  expect(() => {
    privateDirectory(f.request.root);
  }).toThrow("Installation directory is not private");
});
it("runs backup for explicit server updates even at a new program root; initial student installs never do", async () => {
  const f = fixture("server");
  await installRelease({ ...f.request, update: true }, f.ports);
  expect(f.backup).toHaveBeenCalledTimes(1);
  await uninstallRelease(f.request.root, "server", f.ports);
  expect(f.backup).toHaveBeenCalledTimes(2);
  const initial = fixture("server");
  await installRelease(initial.request, initial.ports);
  expect(initial.backup).not.toHaveBeenCalled();
  const student = fixture();
  await installRelease({ ...student.request, update: true }, student.ports);
  expect(student.backup).not.toHaveBeenCalled();
});
it("uninstalls every selected release while retaining other components and unrelated user state", async () => {
  const f = fixture();
  await installRelease(f.request, f.ports);
  for (const name of [
    "student-0.9.0",
    "server-1.2.3",
    "student-invalid!",
    "xstudent-1.2.3",
    "student-invalid!student-1.2.3",
    "credentials",
  ]) {
    mkdirSync(join(f.request.root, name));
    writeFileSync(join(f.request.root, name, "keep"), "data");
  }
  await uninstallRelease(f.request.root, "student", f.ports);
  expect(readdirSync(f.request.root).sort()).toEqual(
    [
      "credentials",
      "server-1.2.3",
      "student-invalid!",
      "xstudent-1.2.3",
      "student-invalid!student-1.2.3",
    ].sort(),
  );
  expect(readActivation(f.request.root)).toBe(null);
});
it("checks source inventory before copying and rechecks private staging after copying", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "unlisted"), "extra");
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("inventory");
  expect(readdirSync(f.request.root)).toEqual([]);
  rmSync(join(f.source, "unlisted"));
  f.ports.verifySignature.mockImplementation(() => {
    writeFileSync(join(f.source, "binary"), "tampered");
  });
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("checksum");
  expect(readdirSync(f.request.root)).toEqual([]);
});
it("accepts the maximum bounded signature file and rejects malformed activation pointer anchors", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "manifest.sigstore.json"), Buffer.alloc(8_388_608));
  await installRelease(f.request, f.ports);
  for (const current of [
    "!student-1.2.3",
    "student-1.2.3!",
    "student-1.2.3\n",
    3,
    true,
    null,
    ["student-1.2.3"],
  ]) {
    writeFileSync(join(f.request.root, "active.json"), JSON.stringify({ current, previous: null }));
    expect(() => readActivation(f.request.root)).toThrow("Invalid activation pointer");
  }
});
it("applies native privacy before state provisioning returns and never adopts an exposed root", () => {
  const f = fixture();
  const state = join(f.temp, "state");
  prepareState(state);
  expect(securePrivatePath).toHaveBeenCalledExactlyOnceWith(state, 0o700);
  expect(mkdirSync).toHaveBeenCalledWith(state, { mode: 0o700 });
  expect(inspectPrivatePath).toHaveBeenCalledWith(state);
  chmodSync(state, 0o755);
  expect(() => {
    prepareState(state);
  }).toThrow("private");
});

it("rejects canonical aliases before modifying state, independently of native ACL verification", () => {
  const f = fixture();
  const alias = join(f.temp, "alias");
  symlinkSync(f.source, alias);
  const inspect = vi.mocked(inspectPrivatePath);
  const nativeInspect = inspect.getMockImplementation();
  if (!nativeInspect) throw new Error("Missing native inspection");
  inspect.mockReturnValueOnce("directory");
  expect(() => {
    privateDirectory(join(alias, "assets"));
  }).toThrow("canonical");
  inspect.mockReset().mockImplementation(nativeInspect);
  const child = join(alias, "new");
  expect(() => {
    prepareState(child);
  }).toThrow("canonical");
  expect(existsSync(child)).toBe(false);
});
it("rehashes the copied staging tree before activation", async () => {
  const f = fixture();
  const copy = vi.mocked(cpSync);
  const actual = copy.getMockImplementation();
  if (!actual) throw new Error("Missing filesystem copy implementation");
  copy.mockImplementationOnce((source, destination, options) => {
    actual(source, destination, options);
    writeFileSync(destination, "tampered while copying");
  });
  await expect(installRelease(f.request, f.ports)).rejects.toThrow("checksum");
  expect(readActivation(f.request.root)).toBe(null);
});
