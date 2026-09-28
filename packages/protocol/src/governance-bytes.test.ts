import { describe, expect, it } from "vitest";

import {
  GovernanceRequestBytesSchema,
  GovernanceResponseBytesSchema,
  governanceRequestByteLimit,
  governanceResponseByteLimit,
  MAX_PENDING_PREVIEWS_PER_ACCOUNT,
  MAX_PENDING_PREVIEWS_PER_INSTALLATION,
  type GovernanceRequest,
  type GovernanceResponse,
} from "./governance.js";

const encoder = new TextEncoder();
const envelope = { protocolVersion: "0.1", requestId: "request:1" };
const access = { ...envelope, kind: "governance-access-query" };
const accessResponse = {
  ...envelope,
  kind: "governance-access-response",
  access: { administrator: true },
};
const exchange = {
  format: "marea-class-exchange:1",
  source: { displayName: "Class" },
  agentMode: "tutoring",
  classInstructions: { tutoring: "Teach", free: "Explore" },
  selection: { didactic: [], evaluation: [] },
};
const previewRequest = {
  ...envelope,
  kind: "governance-class-import-preview",
  centerId: "center:1",
  classId: "class:1",
  expectedTeachingVersion: null,
  package: exchange,
};
const exportResponse = { ...envelope, kind: "governance-class-exported", package: exchange };

function raw(value: object | null, size?: number): Uint8Array {
  const json = JSON.stringify(value);
  const padding = size === undefined ? "" : " ".repeat(size - encoder.encode(json).byteLength);
  return encoder.encode(json + padding);
}

describe("raw governance document limits", () => {
  it("selects the accepted byte bound for every operation, independently of payload size", () => {
    const pairs = [
      ["access-query", "access-response"],
      ["centers-query", "centers-response"],
      ["classes-query", "classes-response"],
      ["accounts-query", "accounts-response"],
      ["memberships-query", "memberships-response"],
      ["class-revision-query", "class-revision-response"],
      ["class-create", "class-created"],
      ["class-rename", "class-renamed"],
      ["account-create", "account-created"],
      ["account-rename", "account-renamed"],
      ["account-state-change", "account-state-changed"],
      ["membership-change", "membership-changed"],
      ["sessions-revoke", "sessions-revoked"],
      ["class-export", "class-exported"],
      ["class-import-preview", "class-import-previewed"],
      ["class-import-confirm", "class-import-confirmed"],
      ["class-import-cancel", "class-import-cancelled"],
    ] as const;
    for (const [index, [request, response]] of pairs.entries()) {
      const requestKind: GovernanceRequest["kind"] = `governance-${request}`;
      const responseKind: GovernanceResponse["kind"] = `governance-${response}`;
      expect(governanceRequestByteLimit(requestKind)).toBe(index < 13 ? 65_536 : 4_194_304);
      expect(governanceResponseByteLimit(responseKind)).toBe(index < 13 ? 262_144 : 4_194_304);
    }
    expect(MAX_PENDING_PREVIEWS_PER_ACCOUNT).toBe(20);
    expect(MAX_PENDING_PREVIEWS_PER_INSTALLATION).toBe(1_000);
  });

  it("counts the received bytes including whitespace, not a reserialized projection", () => {
    expect(GovernanceRequestBytesSchema.parse(raw(access, 65_536))).toEqual(access);
    expect(GovernanceResponseBytesSchema.parse(raw(accessResponse, 262_144))).toEqual(
      accessResponse,
    );
    for (const [schema, value, size] of [
      [GovernanceRequestBytesSchema, access, 65_537],
      [GovernanceResponseBytesSchema, accessResponse, 262_145],
    ] as const) {
      const result = schema.safeParse(raw(value, size));
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toEqual([
          { code: "custom", message: "Document exceeds byte limit.", path: [] },
        ]);
    }
  });

  it("accepts exchange at four MiB but rejects the next byte for both directions", () => {
    expect(GovernanceRequestBytesSchema.parse(raw(previewRequest, 4_194_304))).toEqual(
      previewRequest,
    );
    expect(GovernanceResponseBytesSchema.parse(raw(exportResponse, 4_194_304))).toEqual(
      exportResponse,
    );
    for (const [schema, value] of [
      [GovernanceRequestBytesSchema, previewRequest],
      [GovernanceResponseBytesSchema, exportResponse],
    ] as const) {
      const result = schema.safeParse(raw(value, 4_194_305));
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toEqual([
          { code: "custom", message: "Document exceeds byte limit.", path: [] },
        ]);
    }
    const large = { ...exchange, classInstructions: { tutoring: "á".repeat(70_000), free: "🌊" } };
    expect(GovernanceRequestBytesSchema.parse(raw({ ...previewRequest, package: large }))).toEqual({
      ...previewRequest,
      package: large,
    });
    expect(
      GovernanceResponseBytesSchema.parse(raw({ ...exportResponse, package: large })).kind,
    ).toBe("governance-class-exported");
  });

  it("rejects malformed JSON and UTF-8 without substituting replacement characters", () => {
    const oversizedInvalid = GovernanceRequestBytesSchema.safeParse(
      new Uint8Array(4_194_305).fill(255),
    );
    expect(oversizedInvalid.success).toBe(false);
    if (!oversizedInvalid.success)
      expect(oversizedInvalid.error.issues).toEqual([
        { code: "custom", message: "Document exceeds byte limit.", path: [] },
      ]);
    const withInvalidText = encoder.encode(JSON.stringify(previewRequest).replace("Teach", "#"));
    withInvalidText[withInvalidText.indexOf(35)] = 255;
    for (const bytes of [encoder.encode("{"), withInvalidText]) {
      const result = GovernanceRequestBytesSchema.safeParse(bytes);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toEqual([
          { code: "custom", message: "Invalid UTF-8 JSON document.", path: [] },
        ]);
    }
    expect(GovernanceRequestBytesSchema.safeParse(access).success).toBe(false);
    expect(
      GovernanceRequestBytesSchema.safeParse(raw({ ...access, kind: "access-query" })).success,
    ).toBe(false);
    expect(
      GovernanceRequestBytesSchema.safeParse(raw({ ...access, authority: "operator" })).success,
    ).toBe(false);
    expect(
      GovernanceResponseBytesSchema.safeParse(raw({ ...accessResponse, token: "secret" })).success,
    ).toBe(false);
    expect(GovernanceRequestBytesSchema.safeParse(raw(null)).success).toBe(false);
    const malformedEnvelope = GovernanceRequestBytesSchema.safeParse(
      raw({ ...access, authority: "operator" }),
    );
    expect(malformedEnvelope.success).toBe(false);
    if (!malformedEnvelope.success)
      expect(malformedEnvelope.error.issues).toEqual([
        { code: "custom", message: "Invalid governance document.", path: [] },
      ]);
  });
});
