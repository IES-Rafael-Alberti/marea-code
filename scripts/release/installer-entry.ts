import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { component } from "./manifest.js";
import {
  installRelease,
  privateDirectory,
  prepareState,
  readActivation,
  uninstallRelease,
  verifySignature,
} from "./install.boundary.js";
import { withOfflineBackup } from "./offline-backup.boundary.js";

export async function installerMain(argv: readonly string[]): Promise<void> {
  const [action, rawComponent, ...rest] = argv;
  const selected = component.parse(rawComponent);
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (
      !key ||
      !["--version", "--source", "--repository", "--ref", "--root", "--installation"].includes(
        key,
      ) ||
      !value ||
      flags.has(key)
    )
      throw new Error("Invalid installer arguments");
    flags.set(key, value);
  }
  const required = (key: string): string => {
    const value = flags.get(key);
    if (!value) throw new Error(`Required ${key}`);
    return value;
  };
  if (action === "prepare-state") {
    if (selected !== "server") throw new Error("State provisioning requires server component");
    prepareState(required("--root"));
    return;
  }
  const root = resolve(flags.get("--root") ?? join(homedir(), ".marea-programs", selected));
  const ports = {
    verifySignature,
    privateDirectory,
    withOfflineBackup: <T>(operation: () => Promise<T>) =>
      withOfflineBackup(resolve(required("--installation")), operation),
  };
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(readActivation(root))}\n`);
    return;
  }
  if (action === "uninstall") {
    await uninstallRelease(root, selected, ports);
    return;
  }
  if (action !== "install" && action !== "update")
    throw new Error(
      "Use install, update, status or uninstall with explicit student/server component",
    );
  await installRelease(
    {
      root,
      source: required("--source"),
      version: required("--version"),
      component: selected,
      repository: required("--repository"),
      ref: required("--ref"),
      update: action === "update",
    },
    ports,
  );
  process.stdout.write(
    `Activated ${selected} ${required("--version")}. Start manually from ${root}; active.json records the executable directory.\n`,
  );
}
