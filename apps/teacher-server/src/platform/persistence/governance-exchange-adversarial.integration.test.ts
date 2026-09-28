import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGovernanceService } from "../../governance/service.boundary.js";
import {
  GovernancePreviewClassImportRequestSchema,
  GovernanceConfirmClassImportRequestSchema,
  Sha256DigestSchema,
} from "@marea/protocol";
import {
  governanceServiceFixture,
  governanceEnvelope,
  exchangePackage,
} from "../../governance/service.fixture.js";
import type {
  PreparedClassImportPreview,
  PreparedClassImportConfirmation,
} from "../../governance/contracts.js";
import { GovernanceResourceError } from "../../governance/errors.js";
import { GovernanceExchangeRepository } from "./governance-exchange-repository.js";

describe("prepared exchange transaction invariants on real SQLite", () => {
  let f: ReturnType<typeof governanceServiceFixture>;
  afterEach(() => {
    vi.restoreAllMocks();
    f.database.close();
  });
  beforeEach(() => {
    f = governanceServiceFixture();
  });
  function scope() {
    return { context: f.admin, centerId: "center:a", classId: "class:a" };
  }
  async function proposal() {
    let prepared: PreparedClassImportPreview | undefined;
    const service = createGovernanceService({
      ...f.dependencies,
      repository: {
        ...f.repository,
        commitClassImportPreview: (input) => {
          prepared = input;
          return f.repository.commitClassImportPreview(input);
        },
      },
    });
    const response = await service.previewClassImport(
      f.session,
      GovernancePreviewClassImportRequestSchema.parse({
        ...governanceEnvelope("governance-class-import-preview"),
        centerId: "center:a",
        classId: "class:a",
        expectedTeachingVersion: null,
        package: exchangePackage,
      }),
    );
    if (prepared === undefined) throw new Error("Expected a prepared preview");
    return {
      ...prepared,
      previewId: response.preview.previewId,
      assertPublicationCurrent: () => undefined,
    };
  }
  function snapshot() {
    return [
      "marea_class_teaching_revisions",
      "marea_current_class_teaching",
      "marea_class_exchange_previews",
      "marea_governance_audit",
    ].map((table) => f.database.readAll(`SELECT * FROM ${table}`));
  }

  it("rejects prepared digest, lifetime, duplicate ID and session-deadline mismatches atomically", async () => {
    const prepared = await proposal();
    const before = snapshot();
    for (const change of [
      { packageDigest: `sha256:${"f".repeat(64)}` },
      { expiresAt: prepared.context.now },
      { expiresAt: "2026-09-12T10:10:00.001Z" },
      { previewId: prepared.previewId },
      { expectedClassVersion: "class:stale" },
      { expectedTeachingVersion: "teaching:stale" },
    ]) {
      expect(() =>
        f.repository.commitClassImportPreview({
          ...prepared,
          previewId: "preview:next",
          ...change,
        } as PreparedClassImportPreview),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(snapshot()).toEqual(before);
    }
    f.database.execute("UPDATE marea_auth_sessions SET expires_at = '2026-09-12T10:05:00.000Z'");
    expect(() =>
      f.repository.commitClassImportPreview({ ...prepared, previewId: "preview:next" }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(snapshot()).toEqual(before);
  });

  it("enforces per-account capacity and clears expired payloads before admitting a new preview", async () => {
    const prepared = await proposal();
    for (let index = 1; index < 20; index++)
      f.repository.commitClassImportPreview({ ...prepared, previewId: `preview:${String(index)}` });
    const before = snapshot();
    expect(() =>
      f.repository.commitClassImportPreview({ ...prepared, previewId: "preview:over-limit" }),
    ).toThrow(GovernanceResourceError);
    expect(snapshot()).toEqual(before);
    f.database.execute(
      "UPDATE marea_class_exchange_previews SET created_at = '2026-09-12T09:50:00.000Z', expires_at = '2026-09-12T10:00:00.000Z'",
    );
    f.repository.commitClassImportPreview({ ...prepared, previewId: "preview:after-expiry" });
    expect(
      f.database.readAll(
        "SELECT DISTINCT state, package_json, settings_json FROM marea_class_exchange_previews WHERE id <> 'preview:after-expiry'",
      ),
    ).toEqual([{ state: "expired", package_json: null, settings_json: null }]);
    expect(() =>
      f.repository.commitClassImportCancellation({ ...scope(), previewId: prepared.previewId }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("enforces installation-wide capacity even for private operator previews", async () => {
    const template = await proposal();
    const prepared = { ...template, context: f.context() };
    for (let index = 1; index < 1000; index++)
      f.repository.commitClassImportPreview({
        ...prepared,
        previewId: `preview:operator:${String(index)}`,
      });
    expect(() =>
      f.repository.commitClassImportPreview({ ...prepared, previewId: "preview:over-limit" }),
    ).toThrow(GovernanceResourceError);
    expect(
      f.database.readOne(
        "SELECT id FROM marea_class_exchange_previews WHERE id = 'preview:over-limit'",
      ),
    ).toBeUndefined();
  });

  it("fails closed with a resource error if the capacity query cannot return its aggregate", async () => {
    const prepared = await proposal();
    const read = f.database.readOne.bind(f.database);
    vi.spyOn(f.database, "readOne").mockImplementation((sql, values) =>
      sql.includes("SELECT COUNT(*) AS total") ? undefined : read(sql, values),
    );
    expect(() =>
      f.repository.commitClassImportPreview({ ...prepared, previewId: "preview:next" }),
    ).toThrow(GovernanceResourceError);
  });

  it("rejects malformed, over-limit or digest-altered stored preview content without publishing", async () => {
    const prepared = await proposal();
    const original = JSON.stringify(prepared.package);
    f.database.execute("UPDATE marea_class_exchange_previews SET package_json = ?1", [
      JSON.stringify({ ...prepared.package, source: { displayName: "Altered" } }),
    ]);
    expect(() => f.repository.loadPendingClassImport(scope(), prepared.previewId)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    for (const field of ["package_json", "settings_json"]) {
      f.database.execute(
        "UPDATE marea_class_exchange_previews SET package_json = ?1, settings_json = ?2",
        [original, JSON.stringify(prepared.settings)],
      );
      f.database.execute(`UPDATE marea_class_exchange_previews SET ${field} = ?1`, [
        JSON.stringify("x".repeat(4_194_304)),
      ]);
      expect(() => f.repository.loadPendingClassImport(scope(), prepared.previewId)).toThrow(
        expect.objectContaining({ code: "request.conflict" }),
      );
    }
    expect(f.database.readAll("SELECT * FROM marea_class_teaching_revisions")).toEqual([]);
  });

  it("accepts exact byte bounds and preserves administrator and operator creator identity", async () => {
    const prepared = await proposal();
    const original = [JSON.stringify(prepared.package), JSON.stringify(prepared.settings)];
    for (const field of ["package_json", "settings_json"]) {
      f.database.execute(
        "UPDATE marea_class_exchange_previews SET package_json = ?1, settings_json = ?2",
        original,
      );
      const json = field === "package_json" ? original[0] : original[1];
      if (json === undefined) throw new Error("Missing fixture JSON");
      f.database.execute(`UPDATE marea_class_exchange_previews SET ${field} = ?1`, [
        json.padEnd(4194304, " "),
      ]);
      const stored = f.repository.loadPendingClassImport(scope(), prepared.previewId);
      expect(stored.creator).toEqual({
        kind: "administrator",
        userId: f.session.identity.userId,
        sessionId: f.session.sessionId,
      });
      expect(stored.package).toEqual(prepared.package);
      expect(stored.settings).toEqual(prepared.settings);
      f.database.execute(`UPDATE marea_class_exchange_previews SET ${field} = ?1`, [
        json.padEnd(4194305, " "),
      ]);
      expect(() => f.repository.loadPendingClassImport(scope(), prepared.previewId)).toThrow(
        expect.objectContaining({ code: "request.conflict" }),
      );
    }
    f.repository.commitClassImportPreview({
      ...prepared,
      context: f.context(),
      previewId: "preview:operator",
    });
    expect(
      f.repository.loadPendingClassImport({ ...scope(), context: f.context() }, "preview:operator")
        .creator,
    ).toEqual({ kind: "operator" });
  });

  it("binds both creator user and session and refuses unknown/cancelled/expired confirmations", async () => {
    const prepared = await proposal();
    const other = f.administrator("center:a", "user:other-admin");
    expect(() =>
      f.repository.loadPendingClassImport({ ...scope(), context: f.context() }, prepared.previewId),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      f.repository.loadPendingClassImport({ ...scope(), context: other }, prepared.previewId),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    f.database.execute("UPDATE marea_class_exchange_previews SET user_id = 'user:other-admin'");
    expect(() => f.repository.loadPendingClassImport(scope(), prepared.previewId)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    f.database.execute("UPDATE marea_class_exchange_previews SET user_id = 'user:admin'");
    expect(() => f.repository.loadPendingClassImport(scope(), "preview:missing")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    f.database.execute(
      "UPDATE marea_class_exchange_previews SET created_at = '2026-09-12T09:50:00.000Z', expires_at = '2026-09-12T10:00:00.000Z'",
    );
    expect(() =>
      f.repository.commitClassImportCancellation({ ...scope(), previewId: prepared.previewId }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("rechecks the complete prepared confirmation, settings and final source guard before publication", async () => {
    const prepared = await proposal();
    let captured: PreparedClassImportConfirmation | undefined;
    const service = createGovernanceService({
      ...f.dependencies,
      repository: {
        ...f.repository,
        commitClassImportConfirmation: (input) => {
          captured = input;
          throw new Error("Capture only");
        },
      },
    });
    await expect(
      service.confirmClassImport(
        f.session,
        GovernanceConfirmClassImportRequestSchema.parse({
          ...governanceEnvelope("governance-class-import-confirm"),
          centerId: "center:a",
          classId: "class:a",
          previewId: prepared.previewId,
        }),
      ),
    ).rejects.toThrow("Capture only");
    if (captured === undefined) throw new Error("Expected a prepared confirmation");
    const confirmation = { ...captured, assertPublicationCurrent: () => undefined };
    const before = snapshot();
    const state = f.repository.loadClassForExchange(scope());
    vi.spyOn(GovernanceExchangeRepository.prototype, "loadClassForExchange").mockReturnValueOnce({
      ...state,
      teachingVersion: "teaching:changed",
      settings: prepared.settings,
    });
    const finalGuard = vi.fn(() => undefined);
    expect(() =>
      f.repository.commitClassImportConfirmation({
        ...confirmation,
        assertPublicationCurrent: finalGuard,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(finalGuard).not.toHaveBeenCalled();
    expect(() =>
      f.repository.commitClassImportConfirmation({
        ...confirmation,
        preview: {
          ...confirmation.preview,
          operatorFingerprint: Sha256DigestSchema.parse(`sha256:${"f".repeat(64)}`),
        },
      }),
    ).toThrow();
    expect(() =>
      f.repository.commitClassImportConfirmation({
        ...confirmation,
        configuration: {
          ...confirmation.configuration,
          classInstructions: { tutoring: "Changed", free: "Changed" },
        },
      }),
    ).toThrow();
    expect(() =>
      f.repository.commitClassImportConfirmation({
        ...confirmation,
        context: { ...confirmation.context, generatedVersion: "revision:wrong" },
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      f.repository.commitClassImportConfirmation({
        ...confirmation,
        assertPublicationCurrent: () => {
          throw new Error("Source changed");
        },
      }),
    ).toThrow("Source changed");
    expect(snapshot()).toEqual(before);
    f.database.executeScript(
      "CREATE TRIGGER reject_import_audit BEFORE INSERT ON marea_governance_audit WHEN NEW.operation = 'class-import-confirm' BEGIN SELECT RAISE(ABORT, 'injected-import-audit'); END;",
    );
    expect(() => f.repository.commitClassImportConfirmation(confirmation)).toThrow(
      "injected-import-audit",
    );
    expect(snapshot()).toEqual(before);
    f.database.executeScript("DROP TRIGGER reject_import_audit");
    f.repository.commitClassImportConfirmation(confirmation);
    expect(() =>
      f.repository.commitClassImportCancellation({ ...scope(), previewId: prepared.previewId }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });
});
