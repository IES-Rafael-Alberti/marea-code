import { localHttpHosts, httpConnectionUrls } from "./http-access.boundary.js";
import { z } from "zod";

import {
  offerAbandonedLockRemoval,
  type LockRecoveryDependencies,
} from "../installation/abandoned-lock-recovery.js";
import { processLockRecovery } from "../installation/lock-recovery-terminal.boundary.js";
import { bunArgon2idPasswordHasher } from "../../identity/password-hasher.boundary.js";
import type { StartResult } from "../operations/contracts.js";
import { bunServe } from "./bun-serve.boundary.js";
import { startTeacherHost, type ServePort } from "./teacher-host.js";

interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface TeacherHostMainDependencies {
  readonly serve: ServePort;
  readonly signals: SignalSource;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly passwords: Parameters<typeof startTeacherHost>[0]["passwords"];
  readonly lockRecovery: LockRecoveryDependencies;
}

/** Exit classes of the host executable: 2 usage, 3 ownership, 5 prerequisites, 6 uncertain stop. */
const START_EXIT: Record<Extract<StartResult, { state: "failed" }>["reason"], 3 | 5> = {
  lock: 3,
  config: 5,
  release: 5,
  storage: 5,
  recovery: 5,
  index: 5,
  assets: 5,
  listen: 5,
};

export function parseHostArguments(
  argv: readonly string[],
): { readonly root: string; readonly releaseId: string; readonly allowHttp: boolean } | undefined {
  const parsed = z
    .tuple([
      z.literal("--installation"),
      z.string(),
      z.literal("--release"),
      z.string(),
      z.literal("--allow-http").optional(),
    ])
    .safeParse(argv);
  return parsed.success
    ? { root: parsed.data[1], releaseId: parsed.data[3], allowHttp: parsed.data[4] !== undefined }
    : undefined;
}

/** Starts the host, serves until SIGINT or SIGTERM, then drains and stops it. */
export async function runTeacherHost(
  argv: readonly string[],
  dependencies: TeacherHostMainDependencies,
): Promise<0 | 2 | 3 | 5 | 6> {
  const parsed = parseHostArguments(argv);
  if (parsed === undefined) {
    dependencies.stderr(
      "Usage: marea-teacher --installation <root> --release <id> [--allow-http]\n",
    );
    return 2;
  }
  const httpHosts = parsed.allowHttp ? localHttpHosts() : undefined;
  if (httpHosts !== undefined)
    dependencies.stderr(
      "HTTP LAN mode: listening on all IPv4 interfaces without transport encryption.\n",
    );
  const startup = new AbortController();
  const start = () =>
    startTeacherHost({
      startupSignal: startup.signal,
      httpHosts,
      installationRoot: parsed.root,
      releaseId: parsed.releaseId,
      serve: dependencies.serve,
      passwords: dependencies.passwords,
      onInferenceDiagnostic: (event) => {
        dependencies.stderr(JSON.stringify(event) + "\n");
      },
      onStartupDiagnostic: (diagnostic) => {
        dependencies.stderr(JSON.stringify(diagnostic) + "\n");
      },
      onEvaluationError: () => {
        dependencies.stderr("Teacher host evaluation work failed; it will retry.\n");
      },
    });
  // The status file reads ready before start returns, so a supervisor may signal at once: listen
  // first and drain after start instead of letting the default handler kill the process.
  const stopRequested = Promise.withResolvers<undefined>();
  const onSignal = () => {
    startup.abort();
    stopRequested.resolve(undefined);
  };
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) dependencies.signals.once(signal, onSignal);
  const stopListening = () => {
    for (const signal of signals) dependencies.signals.removeListener(signal, onSignal);
  };
  let host = await start();
  if (
    host.state === "failed" &&
    host.reason === "lock" &&
    (await offerAbandonedLockRemoval(parsed.root, dependencies.lockRecovery))
  )
    host = await start();
  if (host.state === "failed") {
    stopListening();
    dependencies.stderr(`Teacher host did not start: ${host.reason}.\n`);
    return START_EXIT[host.reason];
  }
  dependencies.stdout(`Teacher host ready at ${host.url}\n`);
  if (httpHosts !== undefined)
    for (const url of httpConnectionUrls(httpHosts, host.url))
      dependencies.stdout(`Student connection: marea --server ${url}\n`);
  await stopRequested.promise;
  stopListening();
  const stopped = await host.stop();
  if (stopped.state === "stopped") {
    dependencies.stdout("Teacher host stopped.\n");
    return 0;
  }
  dependencies.stderr(`Teacher host stop is uncertain: ${stopped.reasonCode}.\n`);
  return 6;
}

/** Production wiring for the compiled `marea-teacher` executable. */
export function runTeacherHostMain(argv: readonly string[] = process.argv.slice(2)) {
  return runTeacherHost(argv, {
    serve: bunServe,
    signals: process,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    passwords: bunArgon2idPasswordHasher,
    lockRecovery: processLockRecovery(),
  });
}
