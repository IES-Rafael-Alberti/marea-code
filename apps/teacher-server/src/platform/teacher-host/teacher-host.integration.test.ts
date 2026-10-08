import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

import { Sha256DigestSchema } from "@marea/protocol";
import { initializeSqliteStorage, openSqliteDatabaseFile } from "@marea/sqlite-storage";

import { nativeOpens } from "../operator-cli/bun-sqlite.fixture.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { AuthorityLineageSchema, TargetRefSchema } from "../operations/schemas.js";
import { parseStorageConfiguration } from "../operations/storage/configuration.js";
import { createSqliteDeletionIndex } from "../operations/storage/sqlite-deletion-index.js";
import { request } from "../../product-http/product-http.fixture.js";
import { startTeacherHost } from "./teacher-host.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "./teacher-host.fixture.js";

afterEach(cleanupTeacherHostInstallations);

const passwords = {
  hash: (secret: string) => Promise.resolve(`hash:${secret}`),
  verify: (secret: string, hash: string) => Promise.resolve(hash === `hash:${secret}`),
};

function installation(options: { readonly activate?: boolean } = {}) {
  const f = teacherHostInstallation(options);
  return f;
}

function start(
  f: ReturnType<typeof installation>,
  releaseId = "release:host",
  onEvaluationError: () => void = () => undefined,
) {
  return startTeacherHost({
    installationRoot: f.root,
    releaseId,
    serve: f.serve,
    passwords,
    onEvaluationError,
  });
}

/** Every connection the host opened, including the deletion index, is closed again. */
function expectConnectionsClosed(): void {
  expect(nativeOpens.filter((open) => !open.closed)).toEqual([]);
}

function status(f: ReturnType<typeof installation>): unknown {
  return JSON.parse(readFileSync(f.host.statusPath, "utf8"));
}

describe("production teacher host", () => {
  it("owns the installation, serves the composed product and stops cleanly", async () => {
    const f = installation();
    const host = await start(f);
    if (host.state !== "ready") throw new Error(`host failed: ${host.reason}`);
    expect(host.url).toBe("http://127.0.0.1:0");
    expect(status(f)).toMatchObject({
      status: "ready",
      releaseId: "release:host",
      schemaVersion: 9,
    });
    expect(() => acquireInstallation(f.root)).toThrow("installation-busy");
    const fetch = f.served.fetch as (request: Request) => Promise<Response>;
    const login = await fetch(
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:login",
      }),
    );
    expect(login.status).toBe(200);
    const dashboard = await fetch(new Request("http://teacher.test/dashboard"));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("Marea");
    const governance = await fetch(
      new Request("http://teacher.test/api/v1/dashboard/governance/classes"),
    );
    expect(governance.headers.get("content-type")).toContain("application/json");

    expect(await host.stop()).toEqual({ state: "stopped", reasonCode: "stopped" });
    expect(f.served.stopped).toBe(true);
    expect(status(f)).toMatchObject({ status: "stopped" });
    const drained = await fetch(new Request("http://teacher.test/dashboard"));
    expect(drained.status).toBe(503);
    expect(await drained.json()).toMatchObject({ error: { retryable: true } });
    expect(existsSync(`${f.databasePath}-wal`)).toBe(false);
    expectConnectionsClosed();
    acquireInstallation(f.root).release();
  });

  it("serves LAN HTTP with exact host/origin checks and reverts on the next ordinary start", async () => {
    const f = installation();
    initializeSqliteStorage({ databasePath: f.databasePath, schema: "observability" }).close();
    writeFileSync(
      join(f.root, "config/server-settings.json"),
      JSON.stringify({
        version: 1,
        revision: 0,
        administrators: ["user:teacher"],
        connections: {},
        identityConnections: {
          "org.marea.google-workspace": {
            clientId: "synthetic-client",
            clientSecret: "synthetic-secret",
            domain: "school.test",
          },
        },
        route: null,
        education: {},
        legacyRoutes: [],
        useCommonRoute: false,
      }),
      { mode: 0o600 },
    );
    f.writeHost({
      ...f.host,
      listen: { hostname: "127.0.0.1", port: 18787 },
      secureDashboardCookie: true,
    });
    const path = join(f.root, "config", "teacher-host.json");
    const original = readFileSync(path, "utf8");
    const loginRequest = (origin = "http://192.168.1.20:18787", host = "192.168.1.20:18787") =>
      new Request(`${origin}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, host },
        body: JSON.stringify({
          credentials: { login: "teacher", password: "teacher-password" },
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: "request:http-login",
        }),
      });
    const host = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: f.serve,
      passwords,
      httpHosts: ["192.168.1.20"],
      onEvaluationError: () => undefined,
    });
    if (host.state !== "ready") throw new Error("HTTP host failed");
    try {
      expect(host.url).toBe("http://0.0.0.0:18787");
      const fetch = f.served.fetch as (request: Request) => Promise<Response>;
      const origin = "http://192.168.1.20:18787";
      const login = await fetch(loginRequest());
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toContain("HttpOnly");
      expect(login.headers.get("set-cookie")).not.toContain("Secure");
      const dashboardSettings = (operation: string) =>
        fetch(
          new Request(`${origin}/api/v1/dashboard/server-settings`, {
            method: "POST",
            headers: {
              origin,
              host: "192.168.1.20:18787",
              "content-type": "application/json",
              cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
            },
            body: JSON.stringify({ operation }),
          }),
        );
      const settings = await dashboardSettings("read");
      expect(settings.status).toBe(200);
      expect(await settings.json()).toMatchObject({ connectionOrigins: [origin] });
      const identity = await dashboardSettings("identity-status");
      expect(identity.status).toBe(200);
      expect(await identity.json()).toMatchObject({
        providers: [
          {
            id: "org.marea.google-workspace",
            kinds: [
              { kind: "email", ready: true },
              { kind: "group", ready: false },
            ],
          },
        ],
      });

      const providers = await fetch(
        new Request(`${origin}/v1/auth/external/providers`, {
          method: "POST",
          headers: { origin, host: "192.168.1.20:18787", "content-type": "application/json" },
          body: JSON.stringify({
            kind: "external-auth-providers-query",
            protocolVersion: "0.1",
            requestId: "request:providers",
          }),
        }),
      );
      expect(providers.status).toBe(200);
      expect(await providers.json()).toMatchObject({
        providers: [{ providerId: "org.marea.google-workspace" }],
      });

      expect(
        (
          await fetch(
            new Request(`${origin}/dashboard`, { headers: { host: "192.168.1.20:18787" } }),
          )
        ).status,
      ).toBe(200);
      expect((await fetch(loginRequest(undefined, "attacker.test:18787"))).status).toBe(403);
      expect((await fetch(loginRequest("http://attacker.test"))).status).toBe(403);
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      await host.stop();
    }
    const ordinary = await start(f);
    if (ordinary.state !== "ready") throw new Error("Ordinary restart failed");
    try {
      expect(ordinary.url).toBe("http://127.0.0.1:18787");
      expect((await f.served.fetch?.(loginRequest()))?.status).toBe(403);
    } finally {
      await ordinary.stop();
    }
    expectConnectionsClosed();
  });

  it("refuses unactivated, foreign-release, busy or unrecovered installations", async () => {
    const unactivated = installation({ activate: false });
    expect(await start(unactivated)).toEqual({ state: "failed", reason: "config" });
    expect(existsSync(unactivated.host.statusPath)).toBe(false);

    const f = installation();
    expect(await start(f, "release:other")).toEqual({ state: "failed", reason: "config" });
    const operator = acquireInstallation(f.root);
    expect(await start(f)).toEqual({ state: "failed", reason: "lock" });
    operator.release();
    const operations = JSON.parse(
      readFileSync(join(f.root, "config", "operations.json"), "utf8"),
    ) as Record<string, unknown>;
    const copy = join(f.root, "state", "copy.sqlite");
    copyFileSync(f.databasePath, copy);
    writeFileSync(
      join(f.root, "config", "operations.json"),
      JSON.stringify({ ...operations, databasePath: copy }),
      { mode: 0o600 },
    );
    expect(await start(f)).toEqual({ state: "failed", reason: "config" });
    writeFileSync(join(f.root, "config", "operations.json"), JSON.stringify(operations), {
      mode: 0o600,
    });
    writeFileSync(join(f.root, "config", "teacher-host.json"), "{}", { mode: 0o600 });
    expect(await start(f)).toEqual({ state: "failed", reason: "config" });
    f.writeHost(f.host);
    const ready = await start(f);
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") await ready.stop();
  });

  it("composes configured inference providers and refuses an unrecovered deletion", async () => {
    const f = installation();
    const credential = join(f.root, "state", "openrouter.key");
    writeFileSync(credential, "synthetic-openrouter-key\n", { mode: 0o600 });
    for (const endpoint of [undefined, "https://inference.test/v1"]) {
      f.writeHost({
        ...f.host,
        providers: [
          {
            pluginId: "org.marea.openrouter",
            credentialPath: credential,
            ...(endpoint === undefined ? {} : { endpoint }),
          },
        ],
      });
      const host = await start(f);
      expect(host.state).toBe("ready");
      if (host.state === "ready") await host.stop();
    }
    f.writeHost({
      ...f.host,
      providers: [
        {
          pluginId: "org.marea.openrouter",
          credentialPath: credential,
          endpoint: "http://inference.test/v1",
        },
      ],
    });
    expect(await start(f)).toEqual({ state: "failed", reason: "config" });
    acquireInstallation(f.root).release();
    f.writeHost({
      ...f.host,
      providers: [{ pluginId: "org.marea.openrouter", credentialPath: credential }],
    });
    writeFileSync(credential, "short\n", { mode: 0o600 });
    expect(await start(f)).toEqual({ state: "failed", reason: "config" });
    expectConnectionsClosed();
    expect(status(f)).toMatchObject({ status: "stopped" });
    acquireInstallation(f.root).release();
    f.writeHost(f.host);
    rmSync(join(f.root, "dashboard", "index.html"));
    expect(await start(f)).toEqual({ state: "failed", reason: "assets" });
    expectConnectionsClosed();
    acquireInstallation(f.root).release();
    writeFileSync(join(f.root, "dashboard", "index.html"), "<!doctype html><title>Marea</title>", {
      mode: 0o600,
    });
    // A listener that cannot bind (for example, the port is taken) stops the host cleanly.
    expect(
      await startTeacherHost({
        installationRoot: f.root,
        releaseId: "release:host",
        serve: () => {
          throw new Error("Failed to start server. Is port 1 in use?");
        },
        passwords,
        onEvaluationError: () => undefined,
      }),
    ).toEqual({ state: "failed", reason: "listen" });
    expectConnectionsClosed();
    expect(status(f)).toMatchObject({ status: "stopped" });
    acquireInstallation(f.root).release();
    const index = openSqliteDatabaseFile({
      databasePath: join(f.root, "state", "deletion-index.sqlite"),
    });
    try {
      await createSqliteDeletionIndex(
        index.database,
        parseStorageConfiguration({
          installationRoot: f.root,
          databasePath: f.databasePath,
          indexPath: join(f.root, "state", "deletion-index.sqlite"),
          authorityLineage: "lineage:host",
          rootId: "root:host",
          databaseLineage: `sha256:${"a".repeat(64)}`,
        }),
      ).prepare({
        operationId: "operation:interrupted",
        authorityLineage: AuthorityLineageSchema.parse("lineage:host"),
        expectedIndexGeneration: 0,
        targets: [
          TargetRefSchema.parse({
            kind: "account",
            key: { userId: "user:gone" },
            observed: { kind: "version", version: "v:1" },
          }),
        ],
        artifactDigest: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`),
      });
    } finally {
      index.close();
    }
    expect(await start(f)).toEqual({ state: "failed", reason: "index" });
    expectConnectionsClosed();
  });

  it("recovers interrupted evaluations before the worker starts polling", async () => {
    const f = installation();
    const database = openSqliteDatabaseFile({ databasePath: f.databasePath });
    try {
      database.database.execute("PRAGMA foreign_keys = OFF");
      for (const [id, generation, state] of [
        ["evaluation:interrupted", 1, "running"],
        ["evaluation:unreadable", 2, "queued"],
      ] as const)
        database.database.execute(
          `INSERT INTO marea_evaluations (id, run_id, generation, action_owner, action_key,
            request_fingerprint, input_json, input_digest, state, created_at, updated_at)
            VALUES (?1, 'run:gone', ?2, 'owner', ?1, 'fingerprint', '{}', 'digest', ?3,
            '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.000Z')`,
          [id, generation, state],
        );
    } finally {
      database.close();
    }
    f.writeHost({ ...f.host, evaluationIntervalMs: 1 });
    let failures = 0;
    const host = await start(f, "release:host", () => {
      failures += 1;
    });
    if (host.state !== "ready") throw new Error(`host failed: ${host.reason}`);
    await vi.waitFor(() => {
      expect(failures).toBeGreaterThan(0);
    });
    await host.stop();
    const check = openSqliteDatabaseFile({ databasePath: f.databasePath });
    try {
      expect(
        check.database.readAll("SELECT id, state, failure_code FROM marea_evaluations ORDER BY id"),
      ).toEqual([
        { id: "evaluation:interrupted", state: "failed", failure_code: "interrupted" },
        { id: "evaluation:unreadable", state: "queued", failure_code: null },
      ]);
    } finally {
      check.close();
    }
  });
});
