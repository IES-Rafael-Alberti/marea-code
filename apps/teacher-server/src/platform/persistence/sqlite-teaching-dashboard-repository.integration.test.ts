import {
  ProtocolErrorResponseSchema,
  SaveTeachingConfigurationResponseSchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
  TeachingConfigurationResponseSchema,
} from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authHeaders,
  buildHarness,
  STUDENT_COOKIE,
  TEACHER_COOKIE,
  dashboardRequest,
  envelope,
  parseEnvelope,
  saveBody,
  type Harness,
} from "./sqlite-teaching-dashboard-repository.fixture.js";
import { fetchJson } from "../../product-http/product-http.fixture.js";

describe("teaching configuration HTTP over SQLite", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.database.close();
  });

  it("composes the module through HTTP for first save, readback and CAS updates", async () => {
    const before = await fetchJson(
      harness.app,
      dashboardRequest(
        "read",
        { ...envelope("teaching-configuration-query", "request:read"), classId: "class:one" },
        authHeaders,
      ),
    );
    expect(parseEnvelope(TeachingConfigurationResponseSchema, before.text)).toMatchObject({
      classId: "class:one",
      configuration: null,
      operatorReady: true,
    });
    const first = await fetchJson(
      harness.app,
      dashboardRequest("save", saveBody(harness), authHeaders),
    );
    expect(first.response.status).toBe(200);
    const saved = parseEnvelope(SaveTeachingConfigurationResponseSchema, first.text);
    expect(saved.configuration.version).toBe("revision:int-1");
    expect(saved.configuration.settings.agentMode).toBe("tutoring");
    expect(first.text).not.toContain("providerRoute");
    expect(first.text).not.toContain("teacherToolPolicy");
    expect(first.text).not.toContain("synthetic-provider");
    expect(first.text).not.toContain("license");
    const update = await fetchJson(
      harness.app,
      dashboardRequest(
        "read",
        { ...envelope("teaching-configuration-query", "request:read2"), classId: "class:one" },
        authHeaders,
      ),
    );
    expect(
      parseEnvelope(TeachingConfigurationResponseSchema, update.text).configuration?.version,
    ).toBe("revision:int-1");
    // The current revision is accepted; only genuinely stale versions conflict.
    const second = await fetchJson(
      harness.app,
      dashboardRequest("save", saveBody(harness, {}, "revision:int-1"), authHeaders),
    );
    expect(second.response.status).toBe(200);
    expect(
      parseEnvelope(SaveTeachingConfigurationResponseSchema, second.text).configuration.version,
    ).toBe("revision:int-2");
    const stale = await fetchJson(
      harness.app,
      dashboardRequest("save", saveBody(harness, {}, "revision:int-1"), authHeaders),
    );
    expect(stale.response.status).toBe(409);
    const concurrent = await Promise.all([
      harness.app.fetch(
        dashboardRequest("save", saveBody(harness, {}, "revision:int-2"), authHeaders),
      ),
      harness.app.fetch(
        dashboardRequest("save", saveBody(harness, {}, "revision:int-2"), authHeaders),
      ),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("keeps two concurrent first saves to one winner", async () => {
    const [left, right] = await Promise.all([
      harness.app.fetch(dashboardRequest("save", saveBody(harness), authHeaders)),
      harness.app.fetch(dashboardRequest("save", saveBody(harness), authHeaders)),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
  });

  it("scopes classes, catalogs and saves to the teacher's current membership", async () => {
    const classes = await fetchJson(
      harness.app,
      dashboardRequest(
        "classes",
        { ...envelope("teaching-classes-query", "request:classes"), afterClassId: null },
        authHeaders,
      ),
    );
    expect(parseEnvelope(TeachingClassesResponseSchema, classes.text).classes).toEqual([
      { classId: "class:one", displayName: "one" },
    ]);
    expect(parseEnvelope(TeachingClassesResponseSchema, classes.text).nextAfterClassId).toBeNull();
    for (const [action, body] of [
      [
        "read",
        { ...envelope("teaching-configuration-query", "request:foreign"), classId: "class:two" },
      ],
      [
        "catalog",
        {
          ...envelope("teaching-catalog-query", "request:foreign"),
          afterSkillId: null,
          classId: "class:two",
        },
      ],
      ["save", { ...saveBody(harness), classId: "class:two" }],
    ] as const) {
      const response = await harness.app.fetch(dashboardRequest(action, body, authHeaders));
      expect(response.status, action).toBe(403);
    }
    const studentResponse = await harness.app.fetch(
      dashboardRequest("save", saveBody(harness), { ...authHeaders, cookie: STUDENT_COOKIE }),
    );
    expect(studentResponse.status).toBe(403);
    expect(
      (
        await harness.app.fetch(
          dashboardRequest("save", saveBody(harness), { origin: authHeaders.origin }),
        )
      ).status,
    ).toBe(401);
    // Same-origin policy applies before authentication for mutation routes.
    expect(
      (
        await harness.app.fetch(
          dashboardRequest("save", saveBody(harness), { cookie: TEACHER_COOKIE }),
        )
      ).status,
    ).toBe(403);
  });

  it("combines didactic and evaluation catalogs with projected metadata only", async () => {
    const catalog = await fetchJson(
      harness.app,
      dashboardRequest(
        "catalog",
        {
          ...envelope("teaching-catalog-query", "request:catalog"),
          afterSkillId: null,
          classId: "class:one",
        },
        authHeaders,
      ),
    );
    const parsed = parseEnvelope(TeachingCatalogResponseSchema, catalog.text);
    expect(parsed.skills.map((skill) => skill.id)).toEqual(["marea/review", "teacher/t1/testing"]);
    expect(parsed.nextAfterSkillId).toBeNull();
    expect(catalog.text).not.toContain("license");
    expect(catalog.text).not.toContain("criteria");
    expect(catalog.text).not.toContain("Frozen");
    expect(catalog.text).not.toContain("SKILL.md");
  });

  it("rechecks membership after asynchronous catalog reads", async () => {
    harness.database.execute(
      "DELETE FROM marea_teacher_classes WHERE teacher_id = 't1' AND class_id = 'class:one'",
    );
    const response = await harness.app.fetch(
      dashboardRequest(
        "catalog",
        {
          ...envelope("teaching-catalog-query", "request:catalog"),
          afterSkillId: null,
          classId: "class:one",
        },
        authHeaders,
      ),
    );
    expect(response.status).toBe(403);
  });

  it("rejects stale, missing and drifted skills with 422 without leaking paths", async () => {
    const stale = await fetchJson(
      harness.app,
      dashboardRequest(
        "save",
        saveBody(harness, {
          settings: {
            agentMode: "tutoring",
            automaticEvaluation: false,
            classInstructions: { tutoring: "a", free: "b" },
            selection: {
              didactic: [{ digest: `sha256:${"0".repeat(64)}`, id: harness.skillIds.didactic }],
              evaluation: [],
            },
          },
        }),
        authHeaders,
      ),
    );
    expect(stale.response.status).toBe(422);
    expect(stale.text).not.toContain("/");
    const drift = await fetchJson(
      harness.app,
      dashboardRequest(
        "save",
        saveBody(harness, {
          settings: {
            agentMode: "tutoring",
            automaticEvaluation: false,
            classInstructions: { tutoring: "a", free: "b" },
            selection: {
              didactic: [{ digest: harness.skillIds.digests.didactic, id: "teacher/t1/absent" }],
              evaluation: [],
            },
          },
        }),
        authHeaders,
      ),
    );
    expect(drift.response.status).toBe(422);
  });

  it("blocks saves and reports readiness while operator prerequisites are missing", async () => {
    const unconfigured = await buildHarness(false);
    try {
      const read = await fetchJson(
        unconfigured.app,
        dashboardRequest(
          "read",
          { ...envelope("teaching-configuration-query", "request:read"), classId: "class:one" },
          authHeaders,
        ),
      );
      expect(parseEnvelope(TeachingConfigurationResponseSchema, read.text).operatorReady).toBe(
        false,
      );
      const save = await fetchJson(
        unconfigured.app,
        dashboardRequest("save", saveBody(unconfigured), authHeaders),
      );
      expect(save.response.status).toBe(503);
      expect(parseEnvelope(ProtocolErrorResponseSchema, save.text).error).toEqual({
        code: "server.error",
        retryable: false,
      });
    } finally {
      unconfigured.database.close();
    }
  });

  it("enforces wire bounds separately from the domain prompt budget", async () => {
    const escaped = "é".repeat(262_144);
    // The wire body is valid and bounded, but the composed prompt exceeds 256 KiB.
    const bounded = await fetchJson(
      harness.app,
      dashboardRequest(
        "save",
        saveBody(harness, {
          settings: {
            agentMode: "tutoring",
            automaticEvaluation: false,
            classInstructions: { free: escaped, tutoring: escaped },
            selection: { didactic: [], evaluation: [] },
          },
        }),
        authHeaders,
      ),
    );
    expect(bounded.response.status).toBe(400);
    expect(parseEnvelope(ProtocolErrorResponseSchema, bounded.text).error).toEqual({
      code: "request.invalid",
      retryable: false,
    });
    expect(bounded.text).not.toContain("256");
    const oversized = await harness.app.fetch(
      dashboardRequest(
        "save",
        saveBody(harness, {
          settings: {
            agentMode: "tutoring",
            automaticEvaluation: false,
            classInstructions: { free: "a".repeat(4_200_000), tutoring: "b" },
            selection: { didactic: [], evaluation: [] },
          },
        }),
        authHeaders,
      ),
    );
    expect(oversized.status).toBe(413);
    const queryOversized = await harness.app.fetch(
      dashboardRequest(
        "classes",
        {
          ...envelope("teaching-classes-query", "request:classes"),
          afterClassId: "x".repeat(70_000),
        },
        authHeaders,
      ),
    );
    expect(queryOversized.status).toBe(413);
  });
});
