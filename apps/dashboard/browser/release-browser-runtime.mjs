/* global process */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
export function launchReleaseBrowser() {
  const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE)("playwright");
  return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
}
/** Starts the compiled synthetic host and resolves once it reports readiness. */
export async function startReleaseHost(legacy, extra = []) {
  const host = spawn(process.env.MAREA_PROFILE_HOST, [...(legacy ? ["--legacy"] : []), ...extra], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await Promise.race([
    once(host.stdout, "data"),
    once(host, "exit").then(([code]) => {
      throw new Error(`Host exited: ${code}`);
    }),
  ]);
  return host;
}
export async function stopReleaseHost(host) {
  if (host.exitCode !== null) return;
  const exited = once(host, "exit");
  host.kill("SIGTERM");
  await exited;
}
