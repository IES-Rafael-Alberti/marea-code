import { ProviderSettingsDescriptorSchema } from "@marea/plugin-api";
import { describe, expect, it } from "vitest";

import { googleWorkspaceSettings, parseGoogleWorkspaceSettings } from "./settings.js";

const base = { clientId: "id", clientSecret: "secret", domain: " School.Test " };
const groups = {
  serviceAccountEmail: "marea@project.iam.gserviceaccount.com",
  serviceAccountKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  adminEmail: "admin@school.test",
};

describe("Google Workspace settings", () => {
  it("publishes the same domain and email constraints used by the parser", () => {
    const validations = googleWorkspaceSettings.fields.filter(
      (field) => field.validation !== undefined,
    );
    expect(
      validations.map((field) => [
        field.key,
        field.validation?.maxLength,
        field.validation?.normalize,
      ]),
    ).toEqual([
      ["domain", 253, "lowercase-trim"],
      ["serviceAccountEmail", 320, "none"],
      ["adminEmail", 320, "none"],
    ]);
    for (const field of validations) {
      const rule = field.validation;
      if (!rule) throw new Error("Missing field validation");
      const valid = field.key === "domain" ? "school.test" : "admin@school.test";
      expect(new RegExp(rule.pattern, "u").test(valid)).toBe(true);
      expect(new RegExp(rule.pattern, "u").test("invalid")).toBe(false);
      for (const locale of ["en", "es", "eu"] as const) expect(rule.message[locale]).not.toBe("");
    }
  });
  it("declares a valid server settings form", () => {
    expect(
      ProviderSettingsDescriptorSchema.parse(googleWorkspaceSettings).fields.map((field) => [
        field.key,
        field.kind,
        field.required,
      ]),
    ).toEqual([
      ["clientId", "text", true],
      ["clientSecret", "secret", true],
      ["domain", "text", true],
      ["serviceAccountEmail", "text", false],
      ["serviceAccountKey", "secret", false],
      ["adminEmail", "text", false],
    ]);
  });

  it("marks multiline private keys in its own descriptor", () => {
    expect(
      googleWorkspaceSettings.fields.find((field) => field.key === "serviceAccountKey")?.multiline,
    ).toBe(true);
  });

  it("normalizes the domain and enables groups only with a complete service account", () => {
    expect(parseGoogleWorkspaceSettings(base)).toEqual({
      clientId: "id",
      clientSecret: "secret",
      domain: "school.test",
      groups: undefined,
    });
    expect(parseGoogleWorkspaceSettings({ ...base, ...groups }).groups).toEqual(groups);
  });

  it.each([
    { ...base, clientId: "" },
    { ...base, clientSecret: "" },
    { clientId: "id", clientSecret: "secret" },
    { ...base, domain: "school" },
    { ...base, domain: "-school.test" },
    { ...base, domain: "school.test/x" },
    { ...base, domain: "school.t" },
    { ...base, serviceAccountEmail: groups.serviceAccountEmail },
    { ...base, ...groups, serviceAccountKey: "not a key" },
    { ...base, ...groups, adminEmail: "admin" },
    { ...base, ...groups, adminEmail: "a b@school.test" },
    { ...base, ...groups, serviceAccountEmail: `${"a".repeat(320)}@x.test` },
    { ...base, ...groups, extra: "x" },
  ])("rejects %j", (values) => {
    expect(() => parseGoogleWorkspaceSettings(values)).toThrow();
  });

  it("accepts long valid domains and labels", () => {
    const label = `a${"b".repeat(61)}c`;
    expect(parseGoogleWorkspaceSettings({ ...base, domain: `${label}.edu.es` }).domain).toBe(
      `${label}.edu.es`,
    );
    expect(() =>
      parseGoogleWorkspaceSettings({ ...base, domain: `a${"b".repeat(62)}c.es` }),
    ).toThrow();
    expect(() =>
      parseGoogleWorkspaceSettings({ ...base, domain: `${"a.".repeat(126)}es` }),
    ).toThrow();
  });
});
