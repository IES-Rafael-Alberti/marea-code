import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = process.argv[2];
const receipt = process.argv[3];
if (!executable || !receipt)
  throw new Error(
    "Usage: bun scripts/release/installed-client-smoke.mjs <compiled-marea> <receipt.json>",
  );
const root = resolve(import.meta.dirname, "../..");
const result = spawnSync(
  process.execPath.includes("bun") ? "node" : process.execPath,
  [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "scripts/release/installed-client.config.mjs",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      MAREA_INSTALLED_CLIENT: resolve(executable),
      MAREA_CLIENT_RECEIPT: resolve(receipt),
    },
    stdio: "inherit",
    timeout: process.platform === "win32" ? 300_000 : 120_000,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
