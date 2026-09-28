import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PublishTeacherNoticeRequestSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operations/retention/retention-bun-sqlite.fixture.js"));

import { schemaEightDatabase } from "../../../test-support/schema-eight-fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
} from "../../identity/system-security.boundary.js";
import { RecordingProvider, request } from "../../product-http/product-http.fixture.js";
import { createTeacherProductHttp } from "../../product-http/teacher-product-http.boundary.js";
import {
  draft,
  request as authoringRequest,
} from "../../teaching/authoring-runtime/skill-authoring-service.fixture.js";
import {
  catalogQuery,
  MemorySkillSource,
  operatorConfiguration,
  syntheticOperatorPolicy,
  syntheticSkill,
} from "../../teaching/configuration/dashboard-module.fixture.js";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import { withoutDeletionAuthority } from "../persistence/identity-creation-guard.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";
import { composeTeacherServices, governanceIdGenerator } from "./teacher-services.js";

const NOW = "2026-09-14T10:00:00.000Z";

function seededDatabase(configuration = teachingConfiguration("free")) {
  const database = schemaEightDatabase();
  database.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:one', 'one', 'Physics')",
  );
  database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('t1', 'teacher', 'hash:teacher-password', 'teacher', 'Teacher', NULL), ('s1', 'student', 'hash:student-password', 'student', 'Student', 'class:one')",
  );
  database.execute(
    "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:one')",
  );
  new SqliteTeachingConfigurationRepository(database).saveRevision({
    classId: "class:one",
    createdAt: NOW,
    configuration,
    expectedVersion: null,
    teacherId: "t1",
  });
  return database;
}

async function composedHost(
  database = seededDatabase(),
  centers: ReadonlyMap<string, string> = new Map(),
  teacherRoot = mkdtempSync(join(tmpdir(), "marea-host-teacher-")),
) {
  const provider = new RecordingProvider();
  const composed = await composeTeacherServices({
    database,
    clock: { now: () => NOW },
    ids: cryptoIdGenerator,
    secrets: cryptoSecretIssuer,
    digest: createHmacSecretDigest(new Uint8Array(32).fill(7)),
    passwords: {
      hash: (secret) => Promise.resolve(`hash:${secret}`),
      verify: (secret, hash) => Promise.resolve(hash === `hash:${secret}`),
    },
    dummyPasswordHash: "hash:dummy",
    operator: operatorConfiguration({
      "class:one": syntheticOperatorPolicy,
      "class:two": syntheticOperatorPolicy,
    }),
    skills: {
      core: new MemorySkillSource([syntheticSkill("evaluation", "evaluate")]),
      centers,
      teachers: new Map([["t1", teacherRoot]]),
      operatorPersonalOwnerForClass: new Map(),
    },
    providers: { resolve: (id) => (id === "synthetic-provider" ? provider : undefined) },
    retry: { wait: () => Promise.resolve() },
    identities: withoutDeletionAuthority(),
    evaluationIntervalMs: 60_000,
    onEvaluationError: () => undefined,
  });
  const app = createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://dashboard.test"],
    serverVersion: "0.2.0",
    services: composed.services,
    governance: composed.governance,
  });
  const call = async (path: string, body: object, credential?: string) => {
    const response = await app.fetch(request(path, body, credential));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { app, call, composed, database, provider };
}

function login(loginName: string, password: string) {
  return {
    credentials: { login: loginName, password },
    kind: "credential-login",
    protocolVersion: "0.1",
    requestId: `request:login-${loginName}`,
  };
}

describe("composed teacher host services", () => {
  it("serves a real student run, budgeted inference and the teacher dashboard over one database", async () => {
    const base = teachingConfiguration("free");
    const host = await composedHost(
      seededDatabase({ ...base, providerRoute: syntheticOperatorPolicy.route.providerRoute }),
    );
    const student = await host.call("/v1/auth/login", login("student", "student-password"));
    expect(student.status).toBe(200);
    const token = (student.body.session as { token: string }).token;
    const bootstrap = await host.call(
      "/v1/classes/bootstrap",
      { kind: "class-bootstrap", protocolVersion: "0.1", requestId: "request:bootstrap" },
      token,
    );
    expect(bootstrap).toMatchObject({ status: 200, body: { activeRun: null } });
    const opened = await host.call(
      "/v1/runs/open",
      {
        clientSessionId: "client:one",
        clientVersion: "0.2.0",
        idempotencyKey: "open:one",
        intent: { kind: "new" },
        project: { displayName: "Wave lab" },
        protocolVersion: "0.1",
        requestId: "request:open",
      },
      token,
    );
    expect(opened.status).toBe(201);
    const lease = opened.body.lease as { token: string; runId: string };

    const model = await host.app.fetch(
      request(
        "/v1/model/stream",
        {
          kind: "model-gateway-request",
          messages: [{ content: "Please help.", role: "student" }],
          modelAlias: "marea",
          protocolVersion: "0.1",
          requestId: "request:model",
          tools: [],
        },
        lease.token,
      ),
    );
    expect(model.status).toBe(200);
    expect(await model.text()).toContain("I can help.");
    expect(host.provider.requests).toHaveLength(1);
    expect(String(host.database.readOne("SELECT id FROM marea_usage_attempts")?.id)).toMatch(
      /^event:[0-9a-f-]{36}$/u,
    );

    const teacher = await host.app.fetch(
      request("/v1/auth/login", login("teacher", "teacher-password")),
    );
    expect(teacher.status).toBe(200);
    const cookie = String(teacher.headers.get("set-cookie")).split(";")[0] ?? "";
    const dashboard = await host.app.fetch(
      new Request(
        "http://teacher.test/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Adashboard&limit=50",
        { headers: { cookie, host: "teacher.test" } },
      ),
    );
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      runs: [{ runId: lease.runId, studentDisplayName: "Student", state: "active" }],
    });

    const teacherIdentity = {
      userId: "t1",
      role: "teacher" as const,
      classId: null,
      displayName: "Teacher",
    };
    const notice = host.composed.services.notices.publish(
      teacherIdentity,
      PublishTeacherNoticeRequestSchema.parse({
        kind: "teacher-notice-publish",
        protocolVersion: "0.1",
        requestId: "request:notice",
        idempotencyKey: "notice:one",
        runId: lease.runId,
        text: "Well done",
      }),
    );
    expect(notice).toMatchObject({ notice: { text: "Well done" } });
    const closed = await host.call(
      "/v1/runs/close",
      { protocolVersion: "0.1", reason: "student-exit", requestId: "request:close" },
      lease.token,
    );
    expect(closed).toMatchObject({ status: 200, body: { state: "closed", runId: lease.runId } });
    expect(
      Number(
        host.database.readOne("SELECT COUNT(*) AS total FROM marea_runs WHERE state = 'closed'")
          ?.total,
      ),
    ).toBe(1);
    host.composed.evaluations.recoverAfterExclusiveStartup();
    host.composed.evaluations.start();
    await host.composed.evaluations.stop();
  });

  it("composes class skill sources from the class center and the teacher's own library", async () => {
    const database = seededDatabase();
    database.execute(
      "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:two', 'two', 'Chemistry')",
    );
    database.execute(
      "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('t2', 'other', 'hash:other', 'teacher', 'Other', NULL)",
    );
    database.execute(
      "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:two'), ('t2', 'class:one')",
    );
    database.execute(
      "INSERT INTO marea_centers (id, display_name, version, created_at, updated_at) VALUES ('center:a', 'Center', 'center:v1', ?1, ?1)",
      [NOW],
    );
    database.execute(
      "INSERT INTO marea_governance_classes (class_id, center_id, version, created_at, updated_at) VALUES ('class:one', 'center:a', 'class:v1', ?1, ?1)",
      [NOW],
    );
    for (const userId of ["t1", "t2"]) {
      database.execute(
        "INSERT INTO marea_governance_accounts (user_id, owner_center_id, state, version, created_at, updated_at) VALUES (?1, 'center:a', 'active', 'account:v1', ?2, ?2)",
        [userId, NOW],
      );
      database.execute(
        "INSERT INTO marea_center_memberships (center_id, user_id, capability, state, version, created_at, updated_at) VALUES ('center:a', ?1, 'member', 'active', 'member:v1', ?2, ?2)",
        [userId, NOW],
      );
      database.execute(
        "INSERT INTO marea_governance_memberships (class_id, center_id, user_id, role, state, version, created_at, updated_at) VALUES ('class:one', 'center:a', ?1, 'teacher', 'active', 'membership:v1', ?2, ?2)",
        [userId, NOW],
      );
    }
    database.execute(
      "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:three', 'three', 'Biology')",
    );
    database.execute(
      "INSERT INTO marea_governance_classes (class_id, center_id, version, created_at, updated_at) VALUES ('class:three', 'center:a', 'class:v1', ?1, ?1)",
      [NOW],
    );
    const centerRoot = mkdtempSync(join(tmpdir(), "marea-host-center-"));
    const teacherRoot = mkdtempSync(join(tmpdir(), "marea-host-teacher-"));
    for (const [root, owner, slug] of [
      [centerRoot, { id: "center:a", source: "center" as const }, "center-rubric"],
      [teacherRoot, { id: "t1", source: "teacher" as const }, "teacher-rubric"],
    ] as const) {
      const store = new SkillAuthoringStore(root, owner);
      await store.initialize();
      await store.create({ ...draft("evaluation", slug), expectedDigest: null });
    }
    const host = await composedHost(database, new Map([["center:a", centerRoot]]), teacherRoot);
    const { teachingConfiguration: teaching, skillAuthoring } = host.composed.services;
    const teacher = (userId: string) => ({
      userId,
      role: "teacher" as const,
      classId: null,
      displayName: "Teacher",
    });
    for (const [userId, classId, expected] of [
      [
        "t1",
        "class:one",
        ["center/center:a/center-rubric", "marea/evaluate", "teacher/t1/teacher-rubric"],
      ],
      ["t1", "class:two", ["marea/evaluate", "teacher/t1/teacher-rubric"]],
      ["t2", "class:one", ["center/center:a/center-rubric", "marea/evaluate"]],
    ] as const)
      expect(
        (await teaching.catalog(teacher(userId), { ...catalogQuery(), classId })).skills
          .map((skill) => skill.id)
          .sort(),
      ).toEqual(expected);
    await expect(
      teaching.catalog(teacher("t2"), { ...catalogQuery(), classId: "class:two" }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    database.execute(
      "UPDATE marea_center_memberships SET capability = 'administrator' WHERE user_id = 't1'",
    );
    const login = await host.app.fetch(
      request("/v1/auth/login", {
        credentials: { login: "teacher", password: "teacher-password" },
        kind: "credential-login",
        protocolVersion: "0.1",
        requestId: "request:admin-login",
      }),
    );
    const classes = await host.app.fetch(
      new Request("http://teacher.test/api/v1/dashboard/governance/classes", {
        method: "POST",
        headers: {
          cookie: String(login.headers.get("set-cookie")).split(";")[0] ?? "",
          host: "teacher.test",
          origin: "https://dashboard.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "governance-classes-query",
          protocolVersion: "0.1",
          requestId: "request:classes",
          centerId: "center:a",
          afterId: null,
        }),
      }),
    );
    expect(classes.status).toBe(200);
    expect(await classes.json()).toMatchObject({
      items: [
        { classId: "class:one", operatorReady: true },
        { classId: "class:three", operatorReady: false },
      ],
    });
    const governanceCookie = String(login.headers.get("set-cookie")).split(";")[0] ?? "";
    const governance = (suffix: string, body: object) =>
      host.app.fetch(
        new Request(`http://teacher.test/api/v1/dashboard/governance/${suffix}`, {
          method: "POST",
          headers: {
            cookie: governanceCookie,
            host: "teacher.test",
            origin: "https://dashboard.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ protocolVersion: "0.1", ...body }),
        }),
      );
    const expectedTeachingVersion = String(
      database.readOne(
        "SELECT revision_id FROM marea_current_class_teaching WHERE class_id = 'class:one'",
      )?.revision_id,
    );
    const scope = { centerId: "center:a", classId: "class:one", expectedTeachingVersion };
    const exported = await governance("class/export", {
      ...scope,
      kind: "governance-class-export",
      requestId: "request:export",
    });
    expect(exported.status).toBe(200);
    const exchange = ((await exported.json()) as { package: unknown }).package;
    const previewed = await governance("class/import/preview", {
      ...scope,
      kind: "governance-class-import-preview",
      requestId: "request:import-preview",
      package: exchange,
    });
    // The exported selection names a teacher skill this library does not hold.
    expect(previewed.status).toBe(422);
    const read = authoringRequest("class:one", "skill-authoring-read", {
      target: { scope: "personal" as const, slug: "practice" },
    });
    expect(await skillAuthoring.read(teacher("t1"), read)).toMatchObject({ skill: null });
    await expect(skillAuthoring.read(teacher("t2"), read)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
  });

  it("namespaces governance identifiers over the host generator", () => {
    const ids = governanceIdGenerator({ createId: (namespace) => `${namespace}:random` });
    expect([ids.createId("revision"), ids.createId("preview")]).toEqual([
      "revision:revision:random",
      "preview:revision:random",
    ]);
  });
});
