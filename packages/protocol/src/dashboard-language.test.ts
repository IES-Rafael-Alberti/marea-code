import { expect, it } from "vitest";
import {
  DashboardLanguageRequestSchema,
  DashboardLanguageResponseSchema,
} from "./dashboard-language.js";
const envelope = { protocolVersion: "0.1", requestId: "language-request" };
it("bounds a separate account preference contract without extending existing profile documents", () => {
  expect(DashboardLanguageRequestSchema.parse({ ...envelope, kind: "read" })).toEqual({
    ...envelope,
    kind: "read",
  });
  for (const preference of ["automatic", "es", "en", "eu"]) {
    expect(
      DashboardLanguageRequestSchema.parse({ ...envelope, kind: "save", preference }),
    ).toMatchObject({ preference });
    expect(DashboardLanguageResponseSchema.parse({ ...envelope, preference }).preference).toBe(
      preference,
    );
  }
  expect(
    DashboardLanguageResponseSchema.parse({ ...envelope, preference: null }).preference,
  ).toBeNull();
  for (const input of [
    { kind: "save" },
    { kind: "save", preference: "fr" },
    { kind: "read", userId: "other" },
    { kind: "read", classId: "class:one" },
    { kind: "read", preference: "en" },
  ])
    expect(DashboardLanguageRequestSchema.safeParse({ ...envelope, ...input }).success).toBe(false);
});
