import { RequestIdSchema, MAX_DASHBOARD_PROFILE_REQUEST_BYTES } from "@marea/protocol";
import { expect, it, vi } from "vitest";
import { dashboardLanguage } from "./language.boundary.js";
import { DashboardProfileError } from "./contracts.js";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
const identity: AuthenticatedIdentity = {
  userId: "user:teacher",
  role: "teacher",
  displayName: "Teacher",
  classId: null,
};
const encode = (body: object) =>
  new TextEncoder().encode(
    JSON.stringify({ protocolVersion: "0.1", requestId: "language-request", ...body }),
  );
it("authorizes the account in the same transaction and returns only its validated preference", () => {
  const profiles = {
    authorized: vi.fn(() => true),
    transaction<T>(work: () => T) {
      return work();
    },
  };
  const language = { read: vi.fn<() => string | null>(() => null), write: vi.fn() };
  const read = encode({ kind: "read" });
  expect(dashboardLanguage(identity, read, profiles, language)).toEqual({
    protocolVersion: "0.1",
    requestId: "language-request",
    preference: null,
  });
  expect(profiles.authorized).toHaveBeenCalledWith("user:teacher", null);
  expect(language.read).toHaveBeenCalledWith("user:teacher");
  expect(language.write).not.toHaveBeenCalled();
  language.read.mockReturnValue("es");
  expect(
    dashboardLanguage(identity, encode({ kind: "save", preference: "es" }), profiles, language),
  ).toHaveProperty("preference", "es");
  expect(language.write).toHaveBeenCalledWith("user:teacher", "es");
  for (const request of [
    new Uint8Array([255]),
    encode({ kind: "read", userId: "other" }),
    encode({ kind: "save", preference: "fr" }),
    new TextEncoder().encode(
      new TextDecoder().decode(read) + " ".repeat(MAX_DASHBOARD_PROFILE_REQUEST_BYTES),
    ),
  ])
    expect(() => dashboardLanguage(identity, request, profiles, language)).toThrow(
      new DashboardProfileError(400),
    );
  language.read.mockReturnValue("invalid");
  expect(() => dashboardLanguage(identity, read, profiles, language)).toThrow(
    new DashboardProfileError(500, RequestIdSchema.parse("language-request")),
  );
  profiles.authorized.mockReturnValue(false);
  expect(() => dashboardLanguage(identity, read, profiles, language)).toThrow(
    new DashboardProfileError(403, RequestIdSchema.parse("language-request")),
  );
  profiles.authorized.mockReturnValue(true);
  expect(() =>
    dashboardLanguage({ ...identity, role: "student" }, read, profiles, language),
  ).toThrow(new DashboardProfileError(403, RequestIdSchema.parse("language-request")));
});
