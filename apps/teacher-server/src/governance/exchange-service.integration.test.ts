import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GovernancePreviewClassImportRequestSchema,
  GovernanceConfirmClassImportRequestSchema,
  GovernanceCancelClassImportRequestSchema,
  GovernanceExportClassRequestSchema,
} from "@marea/protocol";
import {
  governanceServiceFixture,
  exchangePackage,
  governanceEnvelope,
} from "./service.fixture.js";
import { syntheticOperatorPolicy } from "../teaching/configuration/dashboard-module.fixture.js";
import { governanceId as id } from "../platform/persistence/governance-repository.fixture.js";

describe("governance class exchange through real services and SQLite", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  beforeEach(() => {
    f = governanceServiceFixture();
  });
  afterEach(() => {
    f.database.close();
  });
  function preview() {
    return GovernancePreviewClassImportRequestSchema.parse({
      ...governanceEnvelope("governance-class-import-preview"),
      centerId: "center:a",
      classId: "class:a",
      expectedTeachingVersion: null,
      package: exchangePackage,
    });
  }
  function confirmation(previewId: string) {
    return GovernanceConfirmClassImportRequestSchema.parse({
      ...governanceEnvelope("governance-class-import-confirm"),
      centerId: "center:a",
      classId: "class:a",
      previewId,
    });
  }

  it("previews without publication, confirms once as administrator and exports only portable settings", async () => {
    const response = await f.service.previewClassImport(f.session, preview());
    expect(response.preview.settings.automaticEvaluation).toBe(false);
    expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual([]);
    const confirmed = await f.service.confirmClassImport(
      f.session,
      confirmation(response.preview.previewId),
    );
    expect(
      f.database.readOne("SELECT created_by, authority FROM marea_class_teaching_revisions"),
    ).toEqual({ created_by: "user:admin", authority: "administrator" });
    expect(
      f.database.readOne(
        "SELECT state, package_json, settings_json, result_revision_id FROM marea_class_exchange_previews",
      ),
    ).toEqual({
      state: "consumed",
      package_json: null,
      settings_json: null,
      result_revision_id: confirmed.teachingVersion,
    });
    await expect(
      f.service.confirmClassImport(f.session, confirmation(response.preview.previewId)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    const exported = await f.service.exportClass(
      f.session,
      GovernanceExportClassRequestSchema.parse({
        ...governanceEnvelope("governance-class-export"),
        centerId: "center:a",
        classId: "class:a",
        expectedTeachingVersion: confirmed.teachingVersion,
      }),
    );
    expect(exported.package).toEqual({ ...exchangePackage, source: { displayName: "Class" } });
    expect(JSON.stringify(exported)).not.toMatch(
      /synthetic-model|providerId|teacherToolPolicy|automaticEvaluation|created_by/,
    );
    expect(
      f.database.readAll("SELECT * FROM marea_teacher_classes WHERE teacher_id = 'user:admin'"),
    ).toEqual([]);
  });

  it("records the operator without a fabricated user and rejects browser access to its preview", async () => {
    const authority = f.context().authority;
    const proposed = await f.exchange.preview(authority, preview());
    await expect(
      f.service.confirmClassImport(f.session, confirmation(proposed.previewId)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    const result = await f.exchange.confirm(authority, confirmation(proposed.previewId));
    expect(
      f.database.readOne(
        "SELECT created_by, authority FROM marea_class_teaching_revisions WHERE id = ?1",
        [result.teachingVersion],
      ),
    ).toEqual({ created_by: null, authority: "operator" });
    expect(f.database.readAll("SELECT id FROM marea_users")).toEqual([{ id: "user:admin" }]);
  });

  it("cancels only in the creating session and keeps cancellation idempotent", async () => {
    const proposed = await f.service.previewClassImport(f.session, preview());
    const request = GovernanceCancelClassImportRequestSchema.parse({
      ...confirmation(proposed.preview.previewId),
      kind: "governance-class-import-cancel",
    });
    expect(
      f.dependencies.repository.requireSession(f.session.sessionId, id("user:admin"), f.admin.now)
        .userId,
    ).toBe("user:admin");
    const second = f.identities;
    second.createSession({
      userId: "user:admin",
      sessionId: "session:second",
      tokenHash: "second",
      issuedAt: f.admin.now,
      expiresAt: f.session.expiresAt,
    });
    await expect(
      f.service.cancelClassImport({ ...f.session, sessionId: id("session:second") }, request),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect((await f.service.cancelClassImport(f.session, request)).previewId).toBe(
      request.previewId,
    );
    await f.service.cancelClassImport(f.session, request);
    await expect(
      f.service.confirmClassImport(f.session, confirmation(request.previewId)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(
      f.database.readOne("SELECT package_json, settings_json FROM marea_class_exchange_previews"),
    ).toEqual({ package_json: null, settings_json: null });
  });

  it.each(["policy", "class", "session", "expiry"] as const)(
    "rejects changed %s without consuming or publishing",
    async (change) => {
      const proposed = await f.service.previewClassImport(f.session, preview());
      if (change === "policy")
        f.policy({
          ...syntheticOperatorPolicy,
          teacherToolPolicy: {
            ...syntheticOperatorPolicy.teacherToolPolicy,
            version: "policy:changed",
          },
        });
      if (change === "class")
        f.database.execute(
          "UPDATE marea_governance_classes SET version = 'changed' WHERE class_id = 'class:a'",
        );
      if (change === "session")
        f.database.execute("UPDATE marea_auth_sessions SET revoked_at = issued_at");
      if (change === "expiry") f.advance("2026-09-12T10:10:00.000Z");
      await expect(
        f.service.confirmClassImport(f.session, confirmation(proposed.preview.previewId)),
      ).rejects.toThrow();
      expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual([]);
      expect(f.database.readOne("SELECT state FROM marea_class_exchange_previews")).toEqual({
        state: "pending",
      });
    },
  );

  it("rechecks revocation after asynchronous skill loading", async () => {
    const request = GovernancePreviewClassImportRequestSchema.parse({
      ...preview(),
      package: {
        ...exchangePackage,
        selection: {
          didactic: [],
          evaluation: [{ id: f.evaluator.id, digest: f.evaluator.digest }],
        },
      },
    });
    f.beforeLoad(() => {
      f.database.execute(
        "UPDATE marea_center_memberships SET capability = 'member' WHERE user_id = 'user:admin'",
      );
      return Promise.resolve();
    });
    await expect(f.service.previewClassImport(f.session, request)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    expect(f.database.readAll("SELECT * FROM marea_class_exchange_previews")).toEqual([]);
  });
});
