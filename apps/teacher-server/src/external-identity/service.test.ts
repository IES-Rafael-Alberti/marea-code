import { createHash } from "node:crypto";
import { IdentityProviderError } from "@marea/plugin-api";
import {
  ExternalAuthBeginRequestSchema,
  ExternalAuthProvidersRequestSchema,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";
import { externalDisplayName, externalLogin } from "./service.js";
import {
  fixture,
  started,
  completion,
  PROVIDER_ID,
  label,
  PERSON,
  ACCOUNT,
  beginRequest,
  envelope,
} from "./service.fixture.js";

describe("external identity service", () => {
  it("lists providers only while storage and a provider are available", () => {
    const query = ExternalAuthProvidersRequestSchema.parse({
      ...envelope,
      kind: "external-auth-providers-query",
      requestId: "r:providers",
    });
    const test = fixture();
    expect(test.service.enabled()).toBe(true);
    expect(test.service.providers(query)).toEqual({
      kind: "external-auth-providers",
      protocolVersion: "0.1",
      requestId: "r:providers",
      providers: [{ providerId: PROVIDER_ID, displayName: label }],
    });
    test.repository.stored = false;
    expect(test.service.enabled()).toBe(false);
    expect(test.service.providers(query).providers).toEqual([]);
    expect(() => test.service.begin(beginRequest)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    const none = fixture({ providers: false });
    expect(none.service.enabled()).toBe(false);
    expect(none.service.providers(query).providers).toEqual([]);
    expect(() =>
      fixture().service.begin(
        ExternalAuthBeginRequestSchema.parse({
          ...beginRequest,
          providerId: "org.example.unknown",
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("starts a PKCE flow bound to a fresh state, nonce and the loopback redirect", () => {
    const test = fixture();
    const { response, request } = started(test);
    expect(response).toEqual({
      kind: "external-auth-started",
      protocolVersion: "0.1",
      requestId: "r:begin",
      flowId: `secret-${"1".padStart(36, "0")}`,
      authorizationUrl: `https://idp.test/auth?state=${request.state}`,
      expiresAt: "2026-10-05T10:10:00.000Z",
    });
    expect(request).toEqual({
      redirectUri: "http://127.0.0.1:4321/callback",
      state: `secret-${"2".padStart(36, "0")}`,
      nonce: `secret-${"3".padStart(36, "0")}`,
      codeChallenge: createHash("sha256")
        .update(`secret-${"4".padStart(36, "0")}`)
        .digest("base64url"),
    });
  });

  it("verifies the answer, admits matching classes, provisions and opens a session", async () => {
    const test = fixture();
    const { response, request } = started(test);
    await expect(
      test.service.complete(completion(response.flowId, request.state)),
    ).resolves.toEqual({
      kind: "external-authenticated",
      protocolVersion: "0.1",
      requestId: "r:complete",
      principal: { role: "student", displayName: "Ana" },
      session: {
        token: "t".repeat(43),
        issuedAt: "2026-10-05T10:00:00.000Z",
        expiresAt: "2026-10-05T10:30:00.000Z",
      },
    });
    expect(test.provider.responses).toEqual([
      {
        code: "4/code",
        redirectUri: "http://127.0.0.1:4321/callback",
        codeVerifier: `secret-${"4".padStart(36, "0")}`,
        nonce: request.nonce,
        signal: test.signals[0],
      },
    ]);
    expect(test.provider.admissions).toEqual([
      "ana@school.test",
      "other@school.test",
      "ana@school.test",
    ]);
    expect(test.repository.provisioned).toEqual([
      {
        providerId: PROVIDER_ID,
        subject: "sub-1",
        email: "ana@school.test",
        displayName: "Ana",
        admittedClassIds: ["class:a", "class:c"],
        newUserId: "user:1",
        newLogin: externalLogin(PROVIDER_ID, "sub-1"),
        version: "revision:2",
        now: "2026-10-05T10:00:00.000Z",
      },
    ]);
    expect(test.opened).toEqual([ACCOUNT]);
    await expect(test.service.complete(completion(response.flowId, request.state))).rejects.toEqual(
      expect.objectContaining({ code: "auth.invalid" }),
    );
  });

  it("gives the token exchange 10 s and the admission checks their own 20 s", async () => {
    const test = fixture();
    const { response, request } = started(test);
    await test.service.complete(completion(response.flowId, request.state));
    expect(test.budgets).toEqual([10_000, 20_000]);
    expect(test.provider.responses[0]?.signal).toBe(test.signals[0]);
    expect(test.provider.admissionSignals).toHaveLength(3);
    for (const signal of test.provider.admissionSignals) expect(signal).toBe(test.signals[1]);
  });

  it("checks every rule on its own and keeps the class order", async () => {
    const test = fixture();
    test.repository.rules = [
      {
        classId: "class:a",
        rules: [
          { kind: "group", value: "g1" },
          { kind: "email", value: "ana@school.test" },
          { kind: "group", value: "g2" },
        ],
      },
      { classId: "class:b", rules: [{ kind: "group", value: "g3" }] },
    ];
    const { response, request } = started(test);
    await test.service.complete(completion(response.flowId, request.state));
    expect(test.provider.admissions).toEqual(["g1", "ana@school.test", "g2", "g3"]);
    expect(test.repository.provisioned[0]?.admittedClassIds).toEqual(["class:a"]);
  });

  it("rejects unknown, expired or mismatched flows without calling the provider", async () => {
    const test = fixture();
    await expect(test.service.complete(completion("f".repeat(32), "s".repeat(32)))).rejects.toEqual(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    for (const state of ["x".repeat(43), "s".repeat(32)]) {
      const { response } = started(test);
      await expect(test.service.complete(completion(response.flowId, state))).rejects.toEqual(
        expect.objectContaining({ code: "auth.invalid" }),
      );
    }
    const { response, request } = started(test);
    test.clock.value = "2026-10-05T10:10:00.000Z";
    await expect(test.service.complete(completion(response.flowId, request.state))).rejects.toEqual(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(test.provider.responses).toEqual([]);
  });

  it("bounds pending flows and forgets expired ones", () => {
    const test = fixture();
    for (let index = 0; index < 256; index += 1) test.service.begin(beginRequest);
    expect(() => test.service.begin(beginRequest)).toThrow(
      expect.objectContaining({ code: "auth.busy" }),
    );
    test.clock.value = "2026-10-05T10:09:59.999Z";
    expect(() => test.service.begin(beginRequest)).toThrow(
      expect.objectContaining({ code: "auth.busy" }),
    );
    test.clock.value = "2026-10-05T10:10:00.000Z";
    expect(test.service.begin(beginRequest).kind).toBe("external-auth-started");
  });

  it.each([
    [new IdentityProviderError("denied", "denied"), "auth.invalid"],
    [new IdentityProviderError("invalid-response", "invalid"), "auth.invalid"],
    [new IdentityProviderError("unavailable", "down"), "auth.busy"],
  ] as const)("maps provider failure %s to %s", async (failure, code) => {
    const test = fixture();
    test.provider.failure = failure;
    const { response, request } = started(test);
    await expect(test.service.complete(completion(response.flowId, request.state))).rejects.toEqual(
      expect.objectContaining({ code }),
    );
    expect(test.repository.provisioned).toEqual([]);
  });

  it("denies unprovisioned people and propagates unexpected failures", async () => {
    const test = fixture();
    test.repository.account = undefined;
    const first = started(test);
    await expect(
      test.service.complete(completion(first.response.flowId, first.request.state)),
    ).rejects.toEqual(expect.objectContaining({ code: "auth.invalid" }));
    test.provider.admitFailure = new Error("bug");
    const second = started(test);
    await expect(
      test.service.complete(completion(second.response.flowId, second.request.state)),
    ).rejects.toThrow("bug");
    expect(test.opened).toEqual([]);
  });

  it("queues concurrent completions beyond the configured limit until slots free", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture({ maxCompletions: 4 });
      const release = Promise.withResolvers<undefined>();
      test.provider.pending = release.promise.then(() => undefined);
      const flows = Array.from({ length: 6 }, () => started(test));
      const completions = flows.map(({ response, request }) =>
        test.service.complete(completion(response.flowId, request.state)),
      );
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(test.provider.responses).toHaveLength(4);
      release.resolve(undefined);
      await expect(Promise.all(completions)).resolves.toHaveLength(6);
      expect(test.opened).toHaveLength(6);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a completion whose slot wait times out retryable with the same flow", async () => {
    const test = fixture({ maxCompletions: 4, completionWaitMs: 5 });
    const release = Promise.withResolvers<undefined>();
    test.provider.pending = release.promise.then(() => undefined);
    const running = Array.from({ length: 4 }, () => started(test)).map(({ response, request }) =>
      test.service.complete(completion(response.flowId, request.state)),
    );
    const pending = started(test);
    await expect(
      test.service.complete(completion(pending.response.flowId, pending.request.state)),
    ).rejects.toEqual(expect.objectContaining({ code: "auth.busy" }));
    release.resolve(undefined);
    await Promise.all(running);
    await expect(
      test.service.complete(completion(pending.response.flowId, pending.request.state)),
    ).resolves.toMatchObject({ kind: "external-authenticated" });
    expect(test.opened).toHaveLength(5);
  });

  it("never reuses a flow consumed by a duplicate completion while waiting for a slot", async () => {
    const test = fixture({ maxCompletions: 1 });
    const release = Promise.withResolvers<undefined>();
    test.provider.pending = release.promise.then(() => undefined);
    const busy = started(test);
    const running = test.service.complete(completion(busy.response.flowId, busy.request.state));
    const duplicated = started(test);
    const request = completion(duplicated.response.flowId, duplicated.request.state);
    const first = test.service.complete(request);
    const second = test.service.complete(request);
    release.resolve(undefined);
    await running;
    await expect(first).resolves.toMatchObject({ kind: "external-authenticated" });
    await expect(second).rejects.toEqual(expect.objectContaining({ code: "auth.invalid" }));
    expect(test.opened).toHaveLength(2);
  });

  it("bounds provider calls with a default timeout", async () => {
    const test = fixture({ timeout: false });
    const { response, request } = started(test);
    await test.service.complete(completion(response.flowId, request.state));
    expect(test.provider.responses[0]?.signal.aborted).toBe(false);
  });

  it("derives stable private logins and safe display names", () => {
    expect(externalLogin(PROVIDER_ID, "sub-1")).toMatch(/^x-[a-f0-9]{32}$/u);
    expect(externalLogin(PROVIDER_ID, "sub-1")).toBe(externalLogin(PROVIDER_ID, "sub-1"));
    expect(externalLogin(PROVIDER_ID, "sub-2")).not.toBe(externalLogin(PROVIDER_ID, "sub-1"));
    expect(externalLogin("org.example.other", "sub-1")).not.toBe(
      externalLogin(PROVIDER_ID, "sub-1"),
    );
    expect(externalDisplayName({ ...PERSON, displayName: " Ana María " })).toBe("Ana María");
    expect(externalDisplayName({ ...PERSON, displayName: "Ana 🙂" })).toBe("ana");
    expect(externalDisplayName({ subject: "s", email: "🙂@school.test", displayName: "" })).toBe(
      "Student",
    );
  });
});
