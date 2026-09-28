import { describe, expect, it } from "vitest";

import {
  ApprovalIdSchema,
  ClientSessionIdSchema,
  DashboardCursorSchema,
  EffectIdSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  InvitationCodeSchema,
  MessageIdSchema,
  RequestIdSchema,
  RunIdSchema,
  RunTokenSchema,
  SessionTokenSchema,
  SkillIdSchema,
  SnapshotIdSchema,
  ToolCallIdSchema,
} from "./identifiers.js";

describe("opaque identifiers", () => {
  it.each([
    ApprovalIdSchema,
    ClientSessionIdSchema,
    EventIdSchema,
    IdempotencyKeySchema,
    MessageIdSchema,
    RequestIdSchema,
    RunIdSchema,
    SnapshotIdSchema,
    ToolCallIdSchema,
  ])("accepts transport-safe opaque values", (schema) => {
    expect(schema.parse("01J-run:value_1")).toBe("01J-run:value_1");
  });

  it.each(["", " leading", "/absolute", "contains space", "x".repeat(129)])(
    "rejects unsafe value %s",
    (value) => {
      expect(() => RunIdSchema.parse(value)).toThrow();
    },
  );

  it("keeps run credentials and skill provenance transport safe", () => {
    expect(RunTokenSchema.parse("base64url_token_value_with_safe_length_1234")).toContain("token");
    expect(SessionTokenSchema.parse("base64url_session_value_with_safe_length_123")).toContain(
      "session",
    );
    expect(InvitationCodeSchema.parse("invite_code_1234")).toBe("invite_code_1234");
    expect(DashboardCursorSchema.parse("cursor_1")).toBe("cursor_1");
    expect(SkillIdSchema.parse("marea/testing")).toBe("marea/testing");
    expect(SkillIdSchema.parse("teacher/t-1/api-testing")).toBe("teacher/t-1/api-testing");
    expect(SkillIdSchema.parse("center/center-1/testing")).toBe("center/center-1/testing");
  });

  it("allows derived effect identities without weakening portable identifier syntax", () => {
    expect(EffectIdSchema.parse(`workspace:${"a".repeat(246)}`)).toHaveLength(256);
    expect(() => EffectIdSchema.parse(`workspace:${"a".repeat(247)}`)).toThrow();
    expect(() => EffectIdSchema.parse("workspace:bad effect")).toThrow();
  });

  it("enforces token, invitation, and cursor bounds", () => {
    expect(RunTokenSchema.parse("a".repeat(32))).toHaveLength(32);
    expect(RunTokenSchema.parse("a".repeat(512))).toHaveLength(512);
    expect(InvitationCodeSchema.parse("a".repeat(12))).toHaveLength(12);
    expect(InvitationCodeSchema.parse("a".repeat(128))).toHaveLength(128);
    expect(DashboardCursorSchema.parse("a")).toBe("a");
    expect(DashboardCursorSchema.parse("a".repeat(512))).toHaveLength(512);
    expect(() => RunTokenSchema.parse("a".repeat(31))).toThrow();
    expect(() => RunTokenSchema.parse("a".repeat(513))).toThrow();
    expect(() => InvitationCodeSchema.parse("a".repeat(11))).toThrow();
    expect(() => InvitationCodeSchema.parse("a".repeat(129))).toThrow();
    expect(() => DashboardCursorSchema.parse("")).toThrow();
    expect(() => DashboardCursorSchema.parse("a".repeat(513))).toThrow();
  });

  it.each(["invite code 123", "invite/code/123", "invite!code!123"])(
    "rejects unsafe invitation or cursor value %s",
    (value) => {
      expect(() => InvitationCodeSchema.parse(value)).toThrow();
      expect(() => DashboardCursorSchema.parse(value)).toThrow();
    },
  );

  it.each(["marea/a", "marea/a1-b2", "teacher/T-1/api-testing", "center/c:1/x9"])(
    "accepts portable skill ID %s",
    (value) => {
      expect(SkillIdSchema.parse(value)).toBe(value);
    },
  );

  it.each(["marea/Testing", "marea/api_testing", "marea/api--testing", "marea/api-", "marea/-api"])(
    "rejects non-portable skill slug %s",
    (value) => {
      expect(() => SkillIdSchema.parse(value)).toThrow();
    },
  );

  it.each(["marea", "teacher/source-1", "center/source-1"])(
    "enforces the final skill slug length boundary for %s IDs",
    (prefix) => {
      const maximum = `${prefix}/${"a".repeat(64)}`;
      const oversized = `${prefix}/${"a".repeat(65)}`;

      expect(SkillIdSchema.parse(maximum)).toBe(maximum);
      expect(() => SkillIdSchema.parse(oversized)).toThrow();
    },
  );

  it.each([`!${"a".repeat(32)}`, `${"a".repeat(32)}!`])(
    "rejects a run token with unsafe edge characters",
    (value) => {
      expect(() => RunTokenSchema.parse(value)).toThrow();
    },
  );

  it.each([
    "teacher/email@example.com/testing",
    "teacher/../testing",
    "center/center-1/../testing",
    "external/source/testing",
    "marea/-testing",
  ])("rejects unsafe or unsupported skill ID %s", (value) => {
    expect(() => SkillIdSchema.parse(value)).toThrow();
  });
});
