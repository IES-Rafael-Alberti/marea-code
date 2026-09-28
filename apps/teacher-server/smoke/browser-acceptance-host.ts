import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createDashboardAssetHandler,
  loadFileSystemDashboardAssets,
} from "../src/dashboard-assets/index.js";
import type { IdentityRepository } from "../src/identity/contracts.js";
import { IdentityService } from "../src/identity/identity-service.js";
import {
  cryptoIdGenerator,
  cryptoSecretIssuer,
  systemClock,
} from "../src/identity/system-security.boundary.js";
import type { SecretDigest } from "../src/identity/contracts.js";

export interface AcceptanceHostOptions {
  readonly label: "TEACHING" | "GOVERNANCE";
  /** Only these API paths are recorded; login and cookie credentials never are. */
  readonly proofPrefixes: readonly string[];
  readonly createApp: (port: number) => { fetch(request: Request): Response | Promise<Response> };
  readonly close: () => void;
}

/** Synthetic password identity for acceptance hosts: the stored hash is the password itself. */
export function syntheticIdentity(repository: IdentityRepository, digest: SecretDigest) {
  return new IdentityService({
    clock: systemClock,
    digest,
    dummyPasswordHash: "dummy",
    ids: cryptoIdGenerator,
    passwords: {
      hash: (value) => Promise.resolve(value),
      verify: (value, hash) => Promise.resolve(value === hash),
    },
    repository,
    secrets: cryptoSecretIssuer,
  });
}

export function acceptanceRoot(label: AcceptanceHostOptions["label"]): string {
  const root = process.env[`${label}_ACCEPTANCE_ROOT`];
  if (!root) throw new Error(`${label}_ACCEPTANCE_ROOT must be an owned temporary directory`);
  return root;
}

/** Serves the built dashboard and the product HTTP app on loopback until a signal arrives. */
export async function runAcceptanceHost(options: AcceptanceHostOptions): Promise<never> {
  const root = acceptanceRoot(options.label);
  let port = Number(process.env[`${options.label}_ACCEPTANCE_PORT`] ?? "0");
  const serveDashboard = createDashboardAssetHandler(
    await loadFileSystemDashboardAssets(
      resolve(
        process.env[`${options.label}_DASHBOARD_DIST`] ??
          resolve(import.meta.dir, "../../dashboard/dist"),
      ),
    ),
  );
  const host: { app?: ReturnType<AcceptanceHostOptions["createApp"]> } = {};
  async function handleRequest(incoming: IncomingMessage, outgoing: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
    const request = new Request(`http://127.0.0.1:${String(port)}${incoming.url ?? "/"}`, {
      headers: Object.fromEntries(
        Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]],
        ),
      ),
      method: incoming.method ?? "GET",
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    });
    const pathname = new URL(request.url).pathname;
    const response =
      host.app !== undefined && (pathname.startsWith("/api/") || pathname.startsWith("/v1/"))
        ? await host.app.fetch(request)
        : serveDashboard(request);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (options.proofPrefixes.some((prefix) => pathname.startsWith(prefix))) {
      await appendFile(
        join(root, "http-proof.jsonl"),
        JSON.stringify({
          path: pathname,
          status: response.status,
          requestText: Buffer.concat(chunks).toString("utf8"),
          responseText: bytes.toString("utf8"),
        }) + "\n",
      );
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(bytes);
  }
  const server: Server = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing).catch(() => {
      process.stderr.write("Acceptance host request failed\n");
      outgoing.destroy();
      process.exitCode = 1;
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback listener");
  port = address.port;
  host.app = options.createApp(port);
  process.stdout.write(
    `${options.label}_ACCEPTANCE_URL=http://127.0.0.1:${String(port)}/dashboard/index.html\n`,
  );
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
    options.close();
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => {
        process.exit(code);
      });
    });
  }
  process.once("beforeExit", () => {
    void shutdown();
  });
  return new Promise<never>(() => undefined);
}
