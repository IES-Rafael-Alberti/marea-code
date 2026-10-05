import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inspectPrivatePath, securePrivatePath } from "@marea/private-filesystem";
import { verifyFiles } from "./files.boundary.js";
import { selectRelease, signingIdentity, type ReleaseManifest } from "./manifest.js";

export interface InstallRequest {
  readonly source: string;
  readonly root: string;
  readonly version: string;
  readonly component: string;
  readonly repository: string;
  readonly ref: string;
  readonly update?: boolean;
  /** Managed students may return to the school's retained, fully reverified version. */
  readonly reuseVerifiedStudent?: boolean;
}
export interface InstallPorts {
  verifySignature(manifest: string, bundle: string, identity: string): void;
  privateDirectory(path: string): void;
  withOfflineBackup<T>(operation: () => Promise<T>): Promise<T>;
}
export function verifySignature(
  manifest: string,
  bundle: string,
  identity: string,
  executable = "cosign",
): void {
  const result = spawnSync(
    executable,
    [
      "verify-blob",
      "--bundle",
      bundle,
      "--certificate-identity",
      identity,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      manifest,
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  if (result.status !== 0)
    throw new Error("Sigstore identity verification failed; nothing activated");
}
export function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (realpathSync(path) !== resolve(path) || !stat.isDirectory())
    throw new Error("Installation must be a canonical directory");
  if (inspectPrivatePath(path) !== "directory")
    throw new Error("Installation directory is not private");
}
export interface Activation {
  readonly current: string;
  readonly previous: string | null;
}
export function readActivation(root: string): Activation | null {
  const path = join(root, "active.json");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid activation record");
  const value = JSON.parse(readFileSync(path, "utf8")) as { current: unknown; previous: unknown };
  if (value.current === null) throw new Error("Invalid activation pointer");
  for (const entry of [value.current, value.previous]) {
    if (
      entry !== null &&
      (typeof entry !== "string" || !/^(?:student|server)-[0-9A-Za-z.-]+$/u.test(entry))
    )
      throw new Error("Invalid activation pointer");
  }
  return value as Activation;
}
/** Stage, verify twice, then atomically replace a tiny pointer. Old programs and all data remain. */
export async function installRelease(
  request: InstallRequest,
  ports: InstallPorts,
): Promise<ReleaseManifest> {
  const source = resolve(request.source);
  const root = resolve(request.root);
  const existed = existsSync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existed) securePrivatePath(root, 0o700);
  ports.privateDirectory(root);
  const lock = join(root, ".release.lock");
  const descriptor = openSync(lock, "wx", 0o600);
  let staging: string | undefined;
  try {
    staging = mkdtempSync(join(root, ".stage-"));
    for (const name of ["manifest.json", "manifest.sigstore.json"]) {
      const input = join(source, name);
      const stat = lstatSync(input);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8_388_608)
        throw new Error("Invalid signature metadata");
      writeFileSync(join(staging, name), readFileSync(input), { flag: "wx", mode: 0o600 });
    }
    ports.verifySignature(
      join(staging, "manifest.json"),
      join(staging, "manifest.sigstore.json"),
      signingIdentity(request.repository, request.ref),
    );
    const manifest = selectRelease(
      JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")),
      request.version,
      request.component,
      `${process.platform}-${process.arch}`,
    );
    verifyFiles(source, manifest);
    const previous = readActivation(root);
    const name = `${manifest.component}-${manifest.version}`;
    const destination = join(root, name);
    const reuse = existsSync(destination);
    if (reuse) {
      if (manifest.component !== "student" || request.reuseVerifiedStudent !== true)
        throw new Error("Immutable release already exists");
      verifyFiles(destination, manifest);
      if (
        readFileSync(join(destination, "manifest.json"), "utf8") !==
        readFileSync(join(staging, "manifest.json"), "utf8")
      )
        throw new Error("Retained release manifest mismatch");
    }
    for (const file of manifest.files) {
      const output = join(staging, file.path);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      cpSync(join(source, file.path), output, { recursive: false });
      chmodSync(output, file.executable ? 0o500 : 0o400);
    }
    verifyFiles(staging, manifest);
    const prepared = staging;
    const activate = (): Promise<void> => {
      if (!reuse) renameSync(prepared, destination);
      const pointer = join(root, `.active-${randomUUID()}.json`);
      writeFileSync(
        pointer,
        JSON.stringify({ current: name, previous: previous?.current ?? null }),
        { flag: "wx", mode: 0o600 },
      );
      renameSync(pointer, join(root, "active.json"));
      return Promise.resolve();
    };
    if (manifest.component === "server" && (previous !== null || request.update === true))
      await ports.withOfflineBackup(activate);
    else await activate();
    return manifest;
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
    closeSync(descriptor);
    rmSync(lock);
  }
}
/** Removes only the selected component program releases; external data is untouched. */
export async function uninstallRelease(
  root: string,
  selected: string,
  ports: InstallPorts,
): Promise<void> {
  ports.privateDirectory(root);
  const lock = join(root, ".release.lock");
  const descriptor = openSync(lock, "wx", 0o600);
  try {
    const active = readActivation(root);
    if (active === null) return;
    if (!active.current.startsWith(`${selected}-`)) throw new Error("Component selection mismatch");
    const deactivate = (): Promise<void> => {
      rmSync(join(root, "active.json"));
      for (const name of readdirSync(root)) {
        if (name.startsWith(`${selected}-`) && /^(?:student|server)-[0-9A-Za-z.-]+$/u.test(name)) {
          rmSync(join(root, name), { recursive: true, force: true });
        }
      }
      return Promise.resolve();
    };
    if (selected === "server") await ports.withOfflineBackup(deactivate);
    else await deactivate();
  } finally {
    closeSync(descriptor);
    rmSync(lock);
  }
}

/** Provision before writing any server configuration or credentials. Never adopts live state. */
export function prepareState(root: string): void {
  const path = resolve(root);
  if (existsSync(path)) {
    privateDirectory(path);
    if (readdirSync(path).length !== 0) throw new Error("State directory must be empty");
  } else {
    if (realpathSync(dirname(path)) !== dirname(path))
      throw new Error("State parent must be canonical");
    mkdirSync(path, { mode: 0o700 });
    securePrivatePath(path, 0o700);
    privateDirectory(path);
  }
}
