import { describe, expect, it } from "vitest";
import * as z from "zod";

import {
  ClassExchangeSchema,
  GovernanceAccountSchema,
  GovernanceCreateAccountRequestSchema,
  GovernanceCreateClassRequestSchema,
  GovernanceCentersResponseSchema,
  GovernanceClassesResponseSchema,
  GovernanceAccountsResponseSchema,
  GovernanceMembershipsResponseSchema,
  GovernanceClassRevisionQuerySchema,
  GovernanceClassRevisionResponseSchema,
  GovernanceClassCreatedResponseSchema,
  GovernanceClassRenamedResponseSchema,
  GovernanceAccountCreatedResponseSchema,
  GovernanceAccountRenamedResponseSchema,
  GovernanceAccountStateChangedResponseSchema,
  GovernanceMembershipChangedResponseSchema,
  GovernanceSessionsRevokedResponseSchema,
  GovernanceClassExportedResponseSchema,
  GovernanceClassImportPreviewedResponseSchema,
  GovernanceClassImportConfirmedResponseSchema,
  GovernanceClassImportCancelledResponseSchema,
  CenterSchema,
  GovernanceClassSchema,
  MembershipSchema,
  RevocationSchema,
  GovernancePageSchema,
  ImportPreviewSchema,
  GovernanceRequestSchema,
  GovernanceResponseSchema,
  GovernanceChangeMembershipRequestSchema,
  GovernanceChangeAccountStateRequestSchema,
  MAX_GOVERNANCE_PAGE_SIZE,
  MAX_GOVERNANCE_REQUEST_BYTES,
  MAX_GOVERNANCE_RESPONSE_BYTES,
  MAX_IMPORT_PREVIEW_SECONDS,
} from "./governance.js";
const id = "revision:1";
const digest = `sha256:${"a".repeat(64)}`;
const envelope = { protocolVersion: "0.1" as const, requestId: "request:1" };
const exchange = {
  format: "marea-class-exchange:1" as const,
  source: { displayName: "Source class" },
  agentMode: "tutoring" as const,
  classInstructions: { tutoring: "Teach clearly", free: "Explore freely" },
  selection: { didactic: [{ id: "marea/reading", digest }], evaluation: [] },
};
describe("governance protocol", () => {
  it("accepts the exact exchange and rejects private or malformed fields", () => {
    expect(ClassExchangeSchema.parse(exchange)).toEqual(exchange);
    expect(() => ClassExchangeSchema.parse({ ...exchange, route: "private" })).toThrow();
    const invalidTutoring = ClassExchangeSchema.safeParse({
      ...exchange,
      classInstructions: { tutoring: "\0", free: "ok" },
    });
    expect(invalidTutoring.success).toBe(false);
    if (!invalidTutoring.success) {
      expect(invalidTutoring.error.issues).toContainEqual({
        code: "custom",
        path: ["classInstructions", "tutoring"],
        message: "Invalid text.",
      });
    }
    const invalidFree = ClassExchangeSchema.safeParse({
      ...exchange,
      classInstructions: { tutoring: "ok", free: "\0" },
    });
    expect(invalidFree.success).toBe(false);
    if (!invalidFree.success) {
      expect(invalidFree.error.issues).toContainEqual({
        code: "custom",
        path: ["classInstructions", "free"],
        message: "Invalid text.",
      });
    }
    expect(() =>
      ClassExchangeSchema.parse({
        ...exchange,
        classInstructions: { tutoring: "A\ud800", free: "ok" },
      }),
    ).toThrow();
    expect(() =>
      ClassExchangeSchema.parse({ ...exchange, source: { displayName: "A\ud800" } }),
    ).toThrow();
  });
  it("enforces create/update semantics and the student class invariant", () => {
    const createClass = GovernanceCreateClassRequestSchema.parse({
      ...envelope,
      kind: "governance-class-create",
      centerId: id,
      classId: "revision:class",
      displayName: "Class",
      expectedVersion: null,
    });
    expect(createClass.expectedVersion).toBeNull();
    expect(() =>
      GovernanceCreateClassRequestSchema.parse({ ...createClass, expectedVersion: id }),
    ).toThrow();

    const student = {
      ...envelope,
      kind: "governance-account-create",
      centerId: id,
      userId: "revision:user",
      displayName: "Student",
      login: "student-1",
      role: "student" as const,
      classId: null,
      expectedVersion: null,
    };
    expect(() => GovernanceCreateAccountRequestSchema.parse(student)).toThrow();
    expect(
      GovernanceCreateAccountRequestSchema.parse({ ...student, classId: "revision:class" }).classId,
    ).toBe("revision:class");
    expect(() =>
      GovernanceCreateAccountRequestSchema.parse({
        ...student,
        login: "student-1",
        passwordHash: "private",
      }),
    ).toThrow();
    for (const state of ["pending", "active", "disabled"] as const) {
      expect(
        GovernanceAccountSchema.parse({
          userId: id,
          centerId: id,
          displayName: "Student",
          role: "student",
          state,
          version: id,
          canManageAccount: false,
        }).state,
      ).toBe(state);
    }
  });
  it("allows only active create-only memberships", () => {
    const base = {
      ...envelope,
      kind: "governance-membership-change" as const,
      centerId: id,
      classId: "revision:class",
      userId: "revision:user",
    };
    expect(
      GovernanceChangeMembershipRequestSchema.parse({
        ...base,
        state: "active",
        expectedVersion: null,
      }).state,
    ).toBe("active");
    expect(() =>
      GovernanceChangeMembershipRequestSchema.parse({
        ...base,
        state: "revoked",
        expectedVersion: null,
      }),
    ).toThrow();
    expect(
      GovernanceChangeMembershipRequestSchema.parse({
        ...base,
        state: "revoked",
        expectedVersion: id,
      }).state,
    ).toBe("revoked");
    expect(
      GovernanceChangeMembershipRequestSchema.safeParse({
        ...base,
        state: "",
        expectedVersion: id,
      }).success,
    ).toBe(false);
    const diagnostic = GovernanceChangeMembershipRequestSchema.safeParse({
      ...base,
      state: "revoked",
      expectedVersion: null,
    });
    expect(diagnostic.success).toBe(false);
    if (!diagnostic.success) expect(diagnostic.error.issues).toHaveLength(1);
  });
  it("rejects unknown fields and keeps projections free of private values", () => {
    const account = GovernanceAccountSchema.parse({
      userId: id,
      centerId: "revision:center",
      displayName: "Teacher",
      role: "teacher",
      state: "active",
      version: id,
      canManageAccount: true,
    });
    expect(account).not.toHaveProperty("login");
    expect(account).not.toHaveProperty("passwordHash");
    expect(() => GovernanceAccountSchema.parse({ ...account, login: "secret" })).toThrow();
    expect(
      GovernanceChangeAccountStateRequestSchema.safeParse({
        ...envelope,
        kind: "governance-account-state-change",
        centerId: id,
        userId: id,
        state: "",
        expectedVersion: id,
      }).success,
    ).toBe(false);
    const studentDiagnostic = GovernanceCreateAccountRequestSchema.safeParse({
      ...envelope,
      kind: "governance-account-create",
      centerId: id,
      userId: "revision:user",
      displayName: "Student",
      login: "student-1",
      role: "student",
      classId: null,
      expectedVersion: null,
    });
    expect(studentDiagnostic.success).toBe(false);
    if (!studentDiagnostic.success) expect(studentDiagnostic.error.issues).toHaveLength(1);
  });
  it("has 17 distinct request and response discriminators with strict envelopes", () => {
    const requests = [
      { ...envelope, kind: "governance-access-query" },
      { ...envelope, kind: "governance-centers-query", afterId: null },
      { ...envelope, kind: "governance-classes-query", centerId: id, afterId: null },
      { ...envelope, kind: "governance-accounts-query", centerId: id, afterId: null },
      {
        ...envelope,
        kind: "governance-memberships-query",
        centerId: id,
        classId: id,
        afterId: null,
      },
      {
        ...envelope,
        kind: "governance-class-revision-query",
        centerId: id,
        classId: id,
      },
      {
        ...envelope,
        kind: "governance-class-create",
        centerId: id,
        classId: "revision:c",
        displayName: "C",
        expectedVersion: null,
      },
      {
        ...envelope,
        kind: "governance-class-rename",
        centerId: id,
        classId: id,
        displayName: "C",
        expectedVersion: id,
      },
      {
        ...envelope,
        kind: "governance-account-create",
        centerId: id,
        userId: "revision:u",
        displayName: "U",
        login: "user-1",
        role: "teacher",
        classId: null,
        expectedVersion: null,
      },
      {
        ...envelope,
        kind: "governance-account-rename",
        centerId: id,
        userId: id,
        displayName: "U",
        expectedVersion: id,
      },
      {
        ...envelope,
        kind: "governance-account-state-change",
        centerId: id,
        userId: id,
        state: "disabled",
        expectedVersion: id,
      },
      {
        ...envelope,
        kind: "governance-membership-change",
        centerId: id,
        classId: id,
        userId: id,
        state: "active",
        expectedVersion: null,
      },
      {
        ...envelope,
        kind: "governance-sessions-revoke",
        centerId: id,
        userId: id,
        expectedVersion: id,
      },
      {
        ...envelope,
        kind: "governance-class-export",
        centerId: id,
        classId: id,
        expectedTeachingVersion: id,
      },
      {
        ...envelope,
        kind: "governance-class-import-preview",
        centerId: id,
        classId: id,
        expectedTeachingVersion: null,
        package: exchange,
      },
      {
        ...envelope,
        kind: "governance-class-import-confirm",
        centerId: id,
        classId: id,
        previewId: "preview:1",
      },
      {
        ...envelope,
        kind: "governance-class-import-cancel",
        centerId: id,
        classId: id,
        previewId: "preview:1",
      },
    ];
    expect(new Set(requests.map((request) => request.kind)).size).toBe(17);
    expect(
      GovernanceClassRevisionQuerySchema.parse({
        ...envelope,
        kind: "governance-class-revision-query",
        centerId: id,
        classId: id,
      }),
    ).toEqual({
      ...envelope,
      kind: "governance-class-revision-query",
      centerId: id,
      classId: id,
    });
    for (const request of requests) {
      expect(GovernanceRequestSchema.parse(request)).toEqual(request);
      expect(GovernanceRequestSchema.safeParse({ ...request, private: "no" }).success).toBe(false);
      expect(
        GovernanceRequestSchema.safeParse({
          ...request,
          kind: request.kind.replace("governance-", ""),
        }).success,
      ).toBe(false);
    }
    expect(() => GovernanceRequestSchema.parse({ ...requests[0], private: "no" })).toThrow();

    const response = {
      ...envelope,
      kind: "governance-access-response",
      access: { administrator: true },
    };
    expect(GovernanceResponseSchema.parse(response).kind).toBe("governance-access-response");
  });
  it("covers every safe projection, page, preview, and response payload", () => {
    const center = { centerId: id, displayName: "Center", version: id };
    const classroom = {
      classId: id,
      centerId: id,
      displayName: "Class",
      version: id,
      operatorReady: true,
    };
    const account = {
      userId: id,
      centerId: id,
      displayName: "Teacher",
      role: "teacher" as const,
      state: "active" as const,
      version: id,
      canManageAccount: true,
    };
    const membership = {
      classId: id,
      centerId: id,
      userId: id,
      role: "student" as const,
      state: "active" as const,
      version: id,
    };
    const revocation = { userId: id, version: id, revokedAt: "2026-01-01T00:00:00.000Z" };
    const preview = {
      previewId: "preview:1",
      centerId: id,
      classId: id,
      expectedTeachingVersion: null,
      expiresAt: "2026-01-01T00:10:00.000Z",
      packageDigest: digest,
      settings: {
        agentMode: "tutoring" as const,
        classInstructions: exchange.classInstructions,
        selection: exchange.selection,
        automaticEvaluation: false,
      },
      preservesDestinationEvaluationPolicy: true as const,
    };
    expect(CenterSchema.parse(center)).toEqual(center);
    expect(GovernanceClassSchema.parse(classroom)).toEqual(classroom);
    expect(MembershipSchema.parse(membership)).toEqual(membership);
    expect(MembershipSchema.safeParse({ ...membership, state: "" }).success).toBe(false);
    expect(RevocationSchema.parse(revocation)).toEqual(revocation);
    expect(
      GovernancePageSchema(CenterSchema).parse({ items: [center], nextAfterId: null }).items,
    ).toHaveLength(1);
    expect(ImportPreviewSchema.parse(preview)).toEqual(preview);
    for (const field of ["tutoring", "free"] as const) {
      const invalidPreview = ImportPreviewSchema.safeParse({
        ...preview,
        settings: {
          ...preview.settings,
          classInstructions: {
            ...preview.settings.classInstructions,
            [field]: "\u0000",
          },
        },
      });
      expect(invalidPreview.success).toBe(false);
      if (!invalidPreview.success)
        expect(invalidPreview.error.issues).toContainEqual({
          code: "custom",
          message: "Invalid text.",
          path: ["settings"],
        });
    }
    const response = (schema: z.ZodType, kind: string, payload: object) =>
      schema.parse({ ...envelope, kind, ...payload });
    const responses = [
      response(GovernanceCentersResponseSchema, "governance-centers-response", {
        items: [center],
        nextAfterId: null,
      }),
      response(GovernanceClassesResponseSchema, "governance-classes-response", {
        items: [classroom],
        nextAfterId: null,
      }),
      response(GovernanceAccountsResponseSchema, "governance-accounts-response", {
        items: [account],
        nextAfterId: null,
      }),
      response(GovernanceMembershipsResponseSchema, "governance-memberships-response", {
        items: [membership],
        nextAfterId: null,
      }),
      response(GovernanceClassRevisionResponseSchema, "governance-class-revision-response", {
        centerId: id,
        classId: id,
        teachingVersion: null,
      }),
      response(GovernanceClassCreatedResponseSchema, "governance-class-created", { classroom }),
      response(GovernanceClassRenamedResponseSchema, "governance-class-renamed", { classroom }),
      response(GovernanceAccountCreatedResponseSchema, "governance-account-created", { account }),
      response(GovernanceAccountRenamedResponseSchema, "governance-account-renamed", { account }),
      response(GovernanceAccountStateChangedResponseSchema, "governance-account-state-changed", {
        account,
      }),
      response(GovernanceMembershipChangedResponseSchema, "governance-membership-changed", {
        membership,
      }),
      response(GovernanceSessionsRevokedResponseSchema, "governance-sessions-revoked", {
        revocation,
      }),
      response(GovernanceClassExportedResponseSchema, "governance-class-exported", {
        package: exchange,
      }),
      response(GovernanceClassImportPreviewedResponseSchema, "governance-class-import-previewed", {
        preview,
      }),
      response(GovernanceClassImportConfirmedResponseSchema, "governance-class-import-confirmed", {
        classId: id,
        teachingVersion: id,
      }),
      response(GovernanceClassImportCancelledResponseSchema, "governance-class-import-cancelled", {
        previewId: "preview:1",
      }),
    ];
    expect(responses).toHaveLength(16);
    for (const payload of responses) {
      expect(GovernanceResponseSchema.parse(payload)).toEqual(payload);
    }
  });
  it("exposes unchanged transport bounds and bounded pages", () => {
    expect(MAX_GOVERNANCE_REQUEST_BYTES).toBe(64 * 1024);
    expect(MAX_GOVERNANCE_RESPONSE_BYTES).toBe(256 * 1024);
    expect(MAX_GOVERNANCE_PAGE_SIZE).toBe(100);
    expect(MAX_IMPORT_PREVIEW_SECONDS).toBe(600);
  });
});
