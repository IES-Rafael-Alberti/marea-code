import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GovernancePreviewClassImportRequestSchema,
  GovernanceConfirmClassImportRequestSchema,
  GovernanceExportClassRequestSchema,
  UtcTimestampSchema,
} from "@marea/protocol";
import {
  governanceServiceFixture,
  governanceEnvelope,
  exchangePackage,
} from "./service.fixture.js";
import { syntheticOperatorPolicy } from "../teaching/configuration/dashboard-module.fixture.js";
import { materializeConfiguration } from "../teaching/configuration/materialize-configuration.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";
import * as operatorParser from "../platform/operator/operator-configuration-parser.js";
import { createGovernanceService } from "./service.boundary.js";

describe("class exchange preserves teacher opt-in and rechecks private policy", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  beforeEach(() => {
    f = governanceServiceFixture();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.database.close();
  });
  function request(expectedTeachingVersion: string | null = null) {
    return GovernancePreviewClassImportRequestSchema.parse({
      ...governanceEnvelope("governance-class-import-preview"),
      centerId: "center:a",
      classId: "class:a",
      expectedTeachingVersion,
      package: {
        ...exchangePackage,
        selection: {
          didactic: [],
          evaluation: [{ id: f.evaluator.id, digest: f.evaluator.digest }],
        },
      },
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
  async function teacherSave(automaticEvaluation: boolean, expectedVersion: string | null = null) {
    if (expectedVersion === null)
      f.repository.commitChangeMembership({
        context: f.context(),
        centerId: "center:a",
        classId: "class:a",
        userId: "user:admin",
        state: "active",
        expectedVersion: null,
      });
    const configuration = await materializeConfiguration(
      {
        ...request().package,
        classId: "class:a",
        expectedVersion,
        automaticEvaluation,
        teacherToolPolicy: syntheticOperatorPolicy.teacherToolPolicy,
      },
      syntheticOperatorPolicy.route,
      f.source,
      f.ids.createId("revision"),
    );
    return new SqliteTeachingConfigurationRepository(f.database).saveRevision({
      teacherId: "user:admin",
      classId: "class:a",
      expectedVersion,
      configuration,
      createdAt: f.admin.now,
    });
  }

  it("preserves an opted-in exact evaluator but refuses removing or replacing it", async () => {
    const original = await teacherSave(true);
    const revision = original.content.configurationVersion;
    const response = await f.service.previewClassImport(f.session, request(revision));
    expect(response.preview.settings.automaticEvaluation).toBe(true);
    await f.service.confirmClassImport(f.session, confirmation(response.preview.previewId));
    const current = f.repository.loadClassForExchange({
      context: f.admin,
      centerId: "center:a",
      classId: "class:a",
    });
    expect(current.settings?.automaticEvaluation).toBe(true);
    await expect(
      f.service.previewClassImport(
        f.session,
        GovernancePreviewClassImportRequestSchema.parse({
          ...request(current.teachingVersion),
          package: exchangePackage,
        }),
      ),
    ).rejects.toMatchObject({ code: "request.conflict" });
  });

  it("rejects a changed destination opt-in between preview and confirmation", async () => {
    const original = await teacherSave(false);
    const response = await f.service.previewClassImport(
      f.session,
      request(original.content.configurationVersion),
    );
    await teacherSave(true, original.content.configurationVersion);
    const sources = vi.spyOn(f.dependencies.sources, "withSource");
    const before = f.database.readAll("SELECT * FROM marea_class_teaching_revisions");
    await expect(
      f.service.confirmClassImport(f.session, confirmation(response.preview.previewId)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual(before);
    expect(sources).not.toHaveBeenCalled();
  });

  it.each(["preview", "confirm"] as const)(
    "rechecks policy after asynchronous materialization during %s",
    async (phase) => {
      const preview =
        phase === "confirm" ? await f.service.previewClassImport(f.session, request()) : null;
      f.beforeLoad(() => {
        f.policy({
          ...syntheticOperatorPolicy,
          teacherToolPolicy: {
            ...syntheticOperatorPolicy.teacherToolPolicy,
            version: "policy:changed",
          },
        });
        return Promise.resolve();
      });
      const operation =
        preview === null
          ? f.service.previewClassImport(f.session, request())
          : f.service.confirmClassImport(f.session, confirmation(preview.preview.previewId));
      await expect(operation).rejects.toMatchObject({ code: "request.conflict" });
      expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual([]);
    },
  );

  it("rejects missing policy and an inconsistent parser result without creating a preview", async () => {
    f.policy(null);
    await expect(f.service.previewClassImport(f.session, request())).rejects.toMatchObject({
      code: "operator-unconfigured",
    });
    f.policy(syntheticOperatorPolicy);
    vi.spyOn(operatorParser, "parseOperatorDocument").mockReturnValue({
      version: 1,
      forClass: () => null,
    });
    await expect(f.service.previewClassImport(f.session, request())).rejects.toMatchObject({
      code: "operator-unconfigured",
    });
    expect(f.database.readAll("SELECT * FROM marea_class_exchange_previews")).toEqual([]);
  });

  it.each(["preview", "confirm"] as const)(
    "rechecks personal-source eligibility after loading during %s",
    async (phase) => {
      f.repository.commitChangeMembership({
        context: f.context(),
        centerId: "center:a",
        classId: "class:a",
        userId: "user:admin",
        state: "active",
        expectedVersion: null,
      });
      const preview =
        phase === "confirm" ? await f.service.previewClassImport(f.session, request()) : null;
      const before = f.database.readAll("SELECT * FROM marea_governance_audit");
      f.beforeLoad(() => {
        f.database.execute(
          "UPDATE marea_governance_memberships SET state = 'revoked' WHERE user_id = 'user:admin'",
        );
        return Promise.resolve();
      });
      await expect(
        preview === null
          ? f.service.previewClassImport(f.session, request())
          : f.service.confirmClassImport(f.session, confirmation(preview.preview.previewId)),
      ).rejects.toMatchObject({ code: "dashboard.forbidden" });
      expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual([]);
      expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
    },
  );

  it("caps a preview at the creating session's earlier expiration", async () => {
    f.database.execute("UPDATE marea_auth_sessions SET expires_at = '2026-09-12T10:05:00.000Z'");
    const result = await f.service.previewClassImport(
      { ...f.session, expiresAt: UtcTimestampSchema.parse("2026-09-12T10:05:00.000Z") },
      request(),
    );
    expect(result.preview.expiresAt).toBe("2026-09-12T10:05:00.000Z");
  });

  it("requires the exact current revision for export and preview", async () => {
    const exportRequest = GovernanceExportClassRequestSchema.parse({
      ...governanceEnvelope("governance-class-export"),
      centerId: "center:a",
      classId: "class:a",
      expectedTeachingVersion: "revision:missing",
    });
    await expect(f.service.exportClass(f.session, exportRequest)).rejects.toMatchObject({
      code: "request.conflict",
    });
    await teacherSave(false);
    await expect(f.service.exportClass(f.session, exportRequest)).rejects.toMatchObject({
      code: "request.conflict",
    });
    const sources = vi.spyOn(f.dependencies.sources, "withSource");
    await expect(f.service.previewClassImport(f.session, request())).rejects.toMatchObject({
      code: "request.conflict",
    });
    expect(sources).not.toHaveBeenCalled();
    const current = f.repository.loadClassForExchange({
      context: f.admin,
      centerId: "center:a",
      classId: "class:a",
    });
    const inconsistent = createGovernanceService({
      ...f.dependencies,
      repository: {
        ...f.repository,
        loadClassForExchange: () => ({
          ...current,
          teachingVersion: "revision:missing",
          settings: null,
        }),
      },
    });
    await expect(inconsistent.exportClass(f.session, exportRequest)).rejects.toMatchObject({
      code: "request.conflict",
    });
  });
});
