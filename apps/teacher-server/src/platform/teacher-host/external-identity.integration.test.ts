import type { ExternalIdentity, IdentityProvider } from "@marea/plugin-api";
import { createStudentIdentityMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operations/retention/retention-bun-sqlite.fixture.js"));

import { request } from "../../product-http/product-http.fixture.js";
import { NOW, composedHost, login, seededDatabase } from "./teacher-services.fixture.js";

const PROVIDER_ID = "org.example.idp";
const label = { es: "Centro", en: "School", eu: "Ikastetxea" };
const ANA: ExternalIdentity = {
  subject: "ana-subject",
  email: "ana@school.test",
  displayName: "Ana",
};

const provider: IdentityProvider = {
  authorizationUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
  complete: ({ code }) =>
    code === "ana" ? Promise.resolve(ANA) : Promise.reject(new Error("unexpected")),
  normalizeRule: (_kind, value) => (value.includes("@") ? value.toLowerCase() : undefined),
  admits: (identity, rules) => Promise.resolve(rules.some((rule) => rule.value === identity.email)),
};

function governedDatabase() {
  const database = seededDatabase();
  for (const migration of createStudentIdentityMigrationCatalog().slice(8))
    for (const sql of migration.statements) database.executeScript(sql);
  database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:two', 'two', 'Chemistry')",
  );
  database.execute(
    "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:two')",
  );
  database.execute(
    "INSERT INTO marea_centers (id, display_name, version, created_at, updated_at) VALUES ('center:a', 'Center', 'v', ?1, ?1)",
    [NOW],
  );
  database.execute(
    "INSERT INTO marea_governance_accounts (user_id, owner_center_id, state, version, created_at, updated_at) VALUES ('t1', 'center:a', 'active', 'v', ?1, ?1)",
    [NOW],
  );
  database.execute(
    "INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at) VALUES ('center:a', 't1', 'member', 'active', 'v', ?1, ?1)",
    [NOW],
  );
  for (const classId of ["class:one", "class:two"]) {
    database.execute(
      "INSERT INTO marea_governance_classes (class_id, center_id, version, created_at, updated_at) VALUES (?1, 'center:a', 'v', ?2, ?2)",
      [classId, NOW],
    );
    database.execute(
      "INSERT INTO marea_governance_memberships (class_id, center_id, user_id, role, state, version, created_at, updated_at) VALUES (?1, 'center:a', 't1', 'teacher', 'active', 'v', ?2, ?2)",
      [classId, NOW],
    );
  }
  return database;
}

async function teacherCookie(host: Awaited<ReturnType<typeof composedHost>>) {
  const response = await host.app.fetch(
    request("/v1/auth/login", login("teacher", "teacher-password")),
  );
  return String(response.headers.get("set-cookie")).split(";")[0] ?? "";
}

async function changeRules(
  host: Awaited<ReturnType<typeof composedHost>>,
  cookie: string,
  classId: string,
  operation: "add" | "remove",
  values: readonly string[],
) {
  const response = await host.app.fetch(
    request(
      "/api/v1/dashboard/external-access",
      {
        kind: "external-access-change",
        protocolVersion: "0.1",
        requestId: `request:${operation}-${classId}`,
        classId,
        operation,
        providerId: PROVIDER_ID,
        ruleKind: "email",
        values,
      },
      undefined,
      { cookie, origin: "https://dashboard.test" },
    ),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function signIn(host: Awaited<ReturnType<typeof composedHost>>) {
  const begun = await host.call("/v1/auth/external/begin", {
    kind: "external-auth-begin",
    protocolVersion: "0.1",
    requestId: "request:begin",
    providerId: PROVIDER_ID,
    redirectUri: "http://127.0.0.1:4321/callback",
  });
  const state = new URL(String(begun.body.authorizationUrl)).searchParams.get("state");
  return host.call("/v1/auth/external/complete", {
    kind: "external-auth-complete",
    protocolVersion: "0.1",
    requestId: "request:complete",
    flowId: begun.body.flowId,
    state,
    code: "ana",
  });
}

function bootstrap(host: Awaited<ReturnType<typeof composedHost>>, token: string) {
  return host.call(
    "/v1/classes/bootstrap",
    { kind: "class-bootstrap", protocolVersion: "0.1", requestId: "request:bootstrap" },
    token,
  );
}

describe("external sign-in through the composed teacher host", () => {
  it("admits listed students into each listed class and follows the teacher's rules", async () => {
    const host = await composedHost(governedDatabase(), undefined, undefined, undefined, [
      {
        id: PROVIDER_ID,
        descriptor: { displayName: label, ruleKinds: [{ kind: "email", label }] },
        provider,
      },
    ]);
    const capabilities = await host.call("/v1/capabilities", {
      requestId: "request:capabilities",
      clientVersion: "0.2.0",
      supportedProtocolVersions: ["0.1"],
    });
    expect(capabilities.body.capabilities).toContain("marea.auth.external");
    expect((await signIn(host)).status).toBe(401);

    const cookie = await teacherCookie(host);
    expect(
      await changeRules(host, cookie, "class:one", "add", ["Ana@School.test", "bad"]),
    ).toMatchObject({
      status: 200,
      body: {
        rules: [{ providerId: PROVIDER_ID, kind: "email", value: "ana@school.test" }],
        rejected: ["bad"],
      },
    });
    const first = await signIn(host);
    expect(first).toMatchObject({ status: 200, body: { principal: { displayName: "Ana" } } });
    const firstToken = (first.body.session as { token: string }).token;
    expect(await bootstrap(host, firstToken)).toMatchObject({
      status: 200,
      body: { kind: "class-bootstrapped", classroom: { displayName: "Physics" } },
    });

    await changeRules(host, cookie, "class:two", "add", ["ana@school.test"]);
    const second = ((await signIn(host)).body.session as { token: string }).token;
    expect(await bootstrap(host, second)).toMatchObject({
      body: {
        kind: "class-selection-required",
        classes: [
          { classId: "class:two", displayName: "Chemistry" },
          { classId: "class:one", displayName: "Physics" },
        ],
      },
    });
    expect(
      await host.call(
        "/v1/classes/select",
        {
          kind: "class-select",
          protocolVersion: "0.1",
          requestId: "request:select",
          classId: "class:two",
        },
        second,
      ),
    ).toMatchObject({ status: 200, body: { classroom: { displayName: "Chemistry" } } });

    await changeRules(host, cookie, "class:two", "remove", ["ana@school.test"]);
    const third = ((await signIn(host)).body.session as { token: string }).token;
    expect(await bootstrap(host, third)).toMatchObject({
      body: { kind: "class-bootstrapped", classroom: { displayName: "Physics" } },
    });
    expect((await bootstrap(host, second)).status).toBe(401);
    expect(
      Number(
        host.database.readOne("SELECT COUNT(*) AS total FROM marea_external_identities")?.total,
      ),
    ).toBe(1);
  });

  it("offers nothing when no identity provider is installed", async () => {
    const host = await composedHost(governedDatabase());
    const capabilities = await host.call("/v1/capabilities", {
      requestId: "request:capabilities",
      clientVersion: "0.2.0",
      supportedProtocolVersions: ["0.1"],
    });
    expect(capabilities.body.capabilities).not.toContain("marea.auth.external");
    expect(host.composed.services.externalIdentity).toBeUndefined();
  });
});
