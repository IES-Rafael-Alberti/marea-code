import { describe, expect, it } from "vitest";

import {
  EXTERNAL_ACCESS_PATH,
  ExternalAccessRequestSchema,
  ExternalAccessResponseSchema,
  ExternalAuthBeginRequestSchema,
  ExternalAuthBeginResponseSchema,
  ExternalAuthCompleteRequestSchema,
  ExternalAuthCompleteResponseSchema,
  ExternalAuthProvidersRequestSchema,
  ExternalAuthProvidersResponseSchema,
  IdentityProviderIdSchema,
  LocalizedLabelSchema,
  LoopbackRedirectUriSchema,
  MAX_EXTERNAL_PROVIDERS,
  MAX_EXTERNAL_RULE_VALUES_PER_CHANGE,
  MAX_EXTERNAL_RULES_PER_CLASS,
} from "./external-identity.js";

const envelope = { protocolVersion: "0.1", requestId: "request-1" } as const;
const label = { es: "Google", en: "Google", eu: "Google" } as const;
const flowId = "f".repeat(32);
const session = {
  token: "t".repeat(43),
  issuedAt: "2026-10-05T10:00:00.000Z",
  expiresAt: "2026-10-05T10:30:00.000Z",
} as const;

describe("external identity protocol", () => {
  it("names the teacher endpoint", () => {
    expect(EXTERNAL_ACCESS_PATH).toBe("/api/v1/dashboard/external-access");
  });

  it.each(["org.marea.google-workspace", "a.b", "a0.b-1", `a.${"b".repeat(126)}`])(
    "accepts provider id %s",
    (value) => {
      expect(IdentityProviderIdSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    "org",
    "Org.marea",
    "1org.marea",
    "-org.marea",
    "org.",
    "org..marea",
    "org.marea_x",
    "org.marea ",
    " org.marea",
    "org.1marea",
    `a.${"b".repeat(127)}`,
  ])("rejects provider id %j", (value) => {
    expect(() => IdentityProviderIdSchema.parse(value)).toThrow();
  });

  it("requires every interface language within bounds", () => {
    expect(LocalizedLabelSchema.parse({ ...label, eu: "x".repeat(120) }).eu).toHaveLength(120);
    for (const invalid of [
      { es: "Google", en: "Google" },
      { ...label, es: "" },
      { ...label, en: "x".repeat(121) },
      { ...label, fr: "Google" },
    ])
      expect(() => LocalizedLabelSchema.parse(invalid)).toThrow();
  });

  it.each(["http://127.0.0.1:1024/callback", "http://127.0.0.1:65535/callback"])(
    "accepts loopback redirect %s",
    (value) => {
      expect(LoopbackRedirectUriSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    "http://127.0.0.1:1023/callback",
    "http://127.0.0.1:65536/callback",
    "http://127.0.0.1:999/callback",
    "http://127.0.0.1:100000/callback",
    "https://127.0.0.1:4000/callback",
    "http://localhost:4000/callback",
    "http://127.0.0.2:4000/callback",
    "http://127.0.0.1:4000/callback/x",
    "http://127.0.0.1:4000/callback?x=1",
    "http://127.0.0.1:4000/",
    " http://127.0.0.1:4000/callback",
    "xhttp://127.0.0.1:4000/callback",
    "http://127.0.0.1:4000/callbackx",
  ])("rejects redirect %s", (value) => {
    expect(LoopbackRedirectUriSchema.safeParse(value).success).toBe(false);
  });

  it("explains a privileged, invalid or remote loopback callback", () => {
    for (const port of ["1023", "65536", "99999", "123456"])
      expect(
        LoopbackRedirectUriSchema.safeParse(`http://127.0.0.1:${port}/callback`).error?.issues[0]
          ?.message,
      ).toBe("Use an unprivileged loopback callback.");
  });

  it("discovers bounded providers without exposing settings", () => {
    expect(
      ExternalAuthProvidersRequestSchema.parse({
        kind: "external-auth-providers-query",
        ...envelope,
      }),
    ).toMatchObject({ kind: "external-auth-providers-query" });
    const provider = { providerId: "org.marea.google-workspace", displayName: label };
    const response = { kind: "external-auth-providers", ...envelope, providers: [provider] };
    expect(ExternalAuthProvidersResponseSchema.parse(response).providers).toHaveLength(1);
    expect(
      ExternalAuthProvidersResponseSchema.parse({
        ...response,
        providers: Array.from({ length: MAX_EXTERNAL_PROVIDERS }, () => provider),
      }).providers,
    ).toHaveLength(8);
    for (const invalid of [
      {
        ...response,
        providers: Array.from({ length: MAX_EXTERNAL_PROVIDERS + 1 }, () => provider),
      },
      { ...response, providers: [{ ...provider, clientId: "secret" }] },
    ])
      expect(() => ExternalAuthProvidersResponseSchema.parse(invalid)).toThrow();
  });

  it("begins a flow for a loopback redirect and returns an https authorization URL", () => {
    const request = {
      kind: "external-auth-begin",
      ...envelope,
      providerId: "org.marea.google-workspace",
      redirectUri: "http://127.0.0.1:4000/callback",
    } as const;
    expect(ExternalAuthBeginRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      ExternalAuthBeginRequestSchema.parse({ ...request, redirectUri: "https://evil.test/" }),
    ).toThrow();
    const response = {
      kind: "external-auth-started",
      ...envelope,
      flowId,
      authorizationUrl: "https://accounts.example.test/auth?x=1",
      expiresAt: "2026-10-05T10:10:00.000Z",
    } as const;
    expect(ExternalAuthBeginResponseSchema.parse(response)).toEqual(response);
    expect(
      ExternalAuthBeginResponseSchema.parse({
        ...response,
        authorizationUrl: `https://a.test/${"x".repeat(4_081)}`,
      }).authorizationUrl,
    ).toHaveLength(4_096);
    for (const invalid of [
      { ...response, authorizationUrl: "http://accounts.example.test/auth" },
      { ...response, authorizationUrl: "javascript:alert(1)" },
      { ...response, authorizationUrl: "xhttps://accounts.example.test/auth" },
      { ...response, authorizationUrl: "httpsx://accounts.example.test/auth" },
      { ...response, authorizationUrl: `https://a.test/${"x".repeat(4_082)}` },
      { ...response, flowId: "f".repeat(31) },
      { ...response, flowId: "f".repeat(129) },
      { ...response, flowId: `${"f".repeat(31)}!` },
      { ...response, flowId: `!${"f".repeat(31)}` },
    ])
      expect(() => ExternalAuthBeginResponseSchema.parse(invalid)).toThrow();
    expect(
      ExternalAuthBeginResponseSchema.parse({ ...response, flowId: "f".repeat(128) }).flowId,
    ).toHaveLength(128);
  });

  it("completes a flow with a visible ASCII authorization code", () => {
    const request = {
      kind: "external-auth-complete",
      ...envelope,
      flowId,
      state: "s".repeat(32),
      code: "4/0AbC-_.~x",
    } as const;
    expect(ExternalAuthCompleteRequestSchema.parse(request)).toEqual(request);
    expect(
      ExternalAuthCompleteRequestSchema.parse({ ...request, code: "x".repeat(2_048) }).code,
    ).toHaveLength(2_048);
    for (const code of ["", "a b", "x".repeat(2_049), "é", "a\n", " a", "a "])
      expect(() => ExternalAuthCompleteRequestSchema.parse({ ...request, code })).toThrow();
    const response = {
      kind: "external-authenticated",
      ...envelope,
      principal: { role: "student", displayName: "Ana" },
      session,
    } as const;
    expect(ExternalAuthCompleteResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      ExternalAuthCompleteResponseSchema.parse({
        ...response,
        principal: { role: "teacher", displayName: "Ana" },
      }),
    ).toThrow();
  });

  it("queries and changes class rules with bounded values", () => {
    const query = { kind: "external-access-query", ...envelope, classId: "class-1" } as const;
    expect(ExternalAccessRequestSchema.parse(query)).toEqual(query);
    const change = {
      kind: "external-access-change",
      ...envelope,
      classId: "class-1",
      operation: "add",
      providerId: "org.marea.google-workspace",
      ruleKind: "email",
      values: ["a@example.test"],
    } as const;
    expect(ExternalAccessRequestSchema.parse(change)).toEqual(change);
    expect(ExternalAccessRequestSchema.parse({ ...change, operation: "remove" })).toMatchObject({
      operation: "remove",
    });
    expect(
      ExternalAccessRequestSchema.parse({
        ...change,
        values: Array.from({ length: MAX_EXTERNAL_RULE_VALUES_PER_CHANGE }, () => "x".repeat(320)),
      }),
    ).toMatchObject({ kind: "external-access-change" });
    for (const invalid of [
      { ...change, values: [] },
      { ...change, values: ["x".repeat(321)] },
      {
        ...change,
        values: Array.from({ length: MAX_EXTERNAL_RULE_VALUES_PER_CHANGE + 1 }, () => "x"),
      },
      { ...change, operation: "replace" },
      { ...change, ruleKind: "Email" },
      { ...change, ruleKind: "1email" },
      { ...change, ruleKind: `e${"x".repeat(32)}` },
      { ...change, ruleKind: "e_mail" },
      { ...query, kind: "external-access-delete" },
    ])
      expect(() => ExternalAccessRequestSchema.parse(invalid)).toThrow();
    expect(
      ExternalAccessRequestSchema.parse({ ...change, ruleKind: `e${"x".repeat(31)}` }),
    ).toMatchObject({ ruleKind: `e${"x".repeat(31)}` });
  });

  it("returns providers, normalized rules and rejected input", () => {
    const provider = {
      providerId: "org.marea.google-workspace",
      displayName: label,
      ruleKinds: [{ kind: "email", label }],
    };
    const rule = { providerId: provider.providerId, kind: "email", value: "a@example.test" };
    const response = {
      kind: "external-access",
      ...envelope,
      classId: "class-1",
      providers: [provider],
      rules: [rule],
      rejected: ["not an email"],
    } as const;
    expect(ExternalAccessResponseSchema.parse(response)).toEqual(response);
    expect(
      ExternalAccessResponseSchema.parse({
        ...response,
        rules: Array.from({ length: MAX_EXTERNAL_RULES_PER_CLASS }, () => rule),
      }).rules,
    ).toHaveLength(500);
    expect(
      ExternalAccessResponseSchema.parse({
        ...response,
        rules: [{ ...rule, value: "x".repeat(320) }],
      }).rules,
    ).toHaveLength(1);
    for (const invalid of [
      { ...response, rules: Array.from({ length: MAX_EXTERNAL_RULES_PER_CLASS + 1 }, () => rule) },
      { ...response, rules: [{ ...rule, value: "" }] },
      { ...response, rules: [{ ...rule, value: "a b" }] },
      { ...response, rules: [{ ...rule, value: "x".repeat(321) }] },
      { ...response, providers: [{ ...provider, ruleKinds: [] }] },
      {
        ...response,
        providers: [
          { ...provider, ruleKinds: Array.from({ length: 9 }, () => provider.ruleKinds[0]) },
        ],
      },
      {
        ...response,
        rejected: Array.from({ length: MAX_EXTERNAL_RULE_VALUES_PER_CHANGE + 1 }, () => "x"),
      },
      { ...response, rejected: ["x".repeat(321)] },
      {
        ...response,
        providers: Array.from({ length: MAX_EXTERNAL_PROVIDERS + 1 }, () => provider),
      },
    ])
      expect(() => ExternalAccessResponseSchema.parse(invalid)).toThrow();
    expect(
      ExternalAccessResponseSchema.parse({
        ...response,
        providers: [
          { ...provider, ruleKinds: Array.from({ length: 8 }, () => provider.ruleKinds[0]) },
        ],
      }).providers[0]?.ruleKinds,
    ).toHaveLength(8);
  });
});
