import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CapabilitiesResponseSchema } from "@marea/protocol";
import { createFileHostStatus } from "../../apps/teacher-server/src/platform/teacher-host/host-status.boundary.js";
import { readTeacherHostConfig } from "../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js";

export async function checkOnboardingPort(port: number, lan: boolean): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
      probe.close(() => {
        resolve();
      });
    });
  });
}

export async function waitForOnboardingHost(
  installation: string,
  dashboardUrl: string,
  stopped: AbortSignal,
): Promise<void> {
  const status = createFileHostStatus();
  const config = readTeacherHostConfig(installation);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (stopped.aborted) throw new Error("host-stopped");
    const observed = await status.read({
      installationRoot: installation,
      statusPath: join(installation, "state", "host-status.json"),
    });
    if (observed?.status === "ready") {
      try {
        const requestId = randomUUID();
        const response = await fetch(
          `http://127.0.0.1:${String(config.listen.port)}/v1/capabilities`,
          {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json", host: new URL(dashboardUrl).host },
            body: JSON.stringify({
              requestId,
              clientVersion: "0.1.0",
              supportedProtocolVersions: ["0.1"],
            }),
            signal: AbortSignal.any([stopped, AbortSignal.timeout(2000)]),
          },
        );
        if (
          response.ok &&
          CapabilitiesResponseSchema.parse(await response.json()).requestId === requestId
        )
          return;
      } catch {
        /* The status file can become ready just before the listener binds. */
      }
    }
    if (observed?.status === "failed") throw new Error("host-failed");
    await delay(200);
  }
  throw new Error("host-start-timeout");
}
