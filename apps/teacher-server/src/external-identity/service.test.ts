/* eslint-disable @typescript-eslint/require-await */
import { createHash } from "node:crypto";

import {
  IdentityProviderError,
  type ExternalIdentity,
  type IdentityAuthorizationRequest,
  type IdentityAuthorizationResponse,
  type IdentityProvider,
} from "@marea/plugin-api";
import {
  ExternalAuthBeginRequestSchema,
  ExternalAuthCompleteRequestSchema,
  ExternalAuthProvidersRequestSchema,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type {
  ClassAdmissionRules,
  ExternalIdentityRepository,
  ExternalProvisioning,
} from "./contracts.js";
import {
  ExternalIdentityService,
  externalDisplayName,
  externalLogin,
  type ExternalIdentityServiceDependencies,
} from "./service.js";

const PROVIDER_ID = "org.example.idp";
const label = { es: "Centro", en: "School", eu: "Ikastetxea" };
const PERSON: ExternalIdentity = { subject: "sub-1", email: "ana@school.test", displayName: "Ana" };
const ACCOUNT: AuthenticatedIdentity = {
  classId: null,
  displayName: "Ana",
  role: "student",
  userId: "user:ana",
};

class FakeProvider implements IdentityProvider {
  readonly requests: IdentityAuthorizationRequest[] = [];
  readonly responses: IdentityAuthorizationResponse[] = [];
  readonly admissions: string[] = [];
  failure: Error | undefined;
  admitFailure: Error | undefined;
  pending: Promise<void> | undefined;

  authorizationUrl(request: IdentityAuthorizationRequest): string {
    this.requests.push(request);
    return `https://idp.test/auth?state=${request.state}`;
  }

  async complete(response: IdentityAuthorizationResponse): Promise<ExternalIdentity> {
    this.responses.push(response);
    await this.pending;
    if (this.failure !== undefined) throw this.failure;
    return PERSON;
  }

  normalizeRule(): string | undefined {
    return undefined;
  }

  async admits(identity: ExternalIdentity, rules: ClassAdmissionRules["rules"]): Promise<boolean> {
    if (this.admitFailure !== undefined) throw this.admitFailure;
    this.admissions.push(rules.map((rule) => rule.value).join(","));
    return rules.some((rule) => rule.value === identity.email);
  }
}

class FakeRepository implements ExternalIdentityRepository {
  stored = true;
  account: AuthenticatedIdentity | undefined = ACCOUNT;
  readonly provisioned: ExternalProvisioning[] = [];
  rules: readonly ClassAdmissionRules[] = [
    { classId: "class:a", rules: [{ kind: "email", value: "ana@school.test" }] },
    { classId: "class:b", rules: [{ kind: "email", value: "other@school.test" }] },
    { classId: "class:c", rules: [{ kind: "email", value: "ana@school.test" }] },
  ];

  available() {
    return this.stored;
  }
  classRules(providerId: string) {
    expect(providerId).toBe(PROVIDER_ID);
    return this.rules;
  }
  provision(input: ExternalProvisioning) {
    this.provisioned.push(input);
    return this.account;
  }
  teacherClassAccess(): boolean {
    throw new Error("unused");
  }
  classRulesFor(): never {
    throw new Error("unused");
  }
  changeRules(): never {
    throw new Error("unused");
  }
}

function fixture(
  options: {
    providers?: boolean;
    timeout?: boolean;
    maxCompletions?: number;
    completionWaitMs?: number;
  } = {},
) {
  const provider = new FakeProvider();
  const repository = new FakeRepository();
  const opened: AuthenticatedIdentity[] = [];
  const clock = { value: "2026-10-05T10:00:00.000Z", now: () => clock.value };
  let secret = 0;
  let id = 0;
  const signals: AbortSignal[] = [];
  const dependencies: ExternalIdentityServiceDependencies = {
    providers:
      options.providers === false
        ? []
        : [
            {
              id: PROVIDER_ID,
              descriptor: { displayName: label, ruleKinds: [{ kind: "email", label }] },
              provider,
            },
          ],
    repository,
    sessions: {
      openExternalSession(identity) {
        opened.push(identity);
        return {
          principal: { role: "student", displayName: identity.displayName },
          session: {
            token: "t".repeat(43),
            issuedAt: clock.now(),
            expiresAt: "2026-10-05T10:30:00.000Z",
          },
        };
      },
    },
    clock,
    ids: { createId: (namespace) => `${namespace}:${String(++id)}` },
    secrets: { issue: () => `secret-${String(++secret).padStart(36, "0")}` },
    ...(options.timeout === false
      ? {}
      : {
          timeout: (milliseconds: number) => {
            expect(milliseconds).toBe(20_000);
            const signal = new AbortController().signal;
            signals.push(signal);
            return signal;
          },
        }),
    ...(options.maxCompletions === undefined
      ? {}
      : { maxConcurrentCompletions: options.maxCompletions }),
    ...(options.completionWaitMs === undefined
      ? {}
      : { completionWaitTimeoutMs: options.completionWaitMs }),
  };
  return {
    service: new ExternalIdentityService(dependencies),
    provider,
    repository,
    opened,
    clock,
    signals,
  };
}

const envelope = { protocolVersion: "0.1" } as const;
const beginRequest = ExternalAuthBeginRequestSchema.parse({
  ...envelope,
  kind: "external-auth-begin",
  requestId: "r:begin",
  providerId: PROVIDER_ID,
  redirectUri: "http://127.0.0.1:4321/callback",
});

function completion(flowId: string, state: string, code = "4/code") {
  return ExternalAuthCompleteRequestSchema.parse({
    ...envelope,
    kind: "external-auth-complete",
    requestId: "r:complete",
    flowId,
    state,
    code,
  });
}

function started(test: ReturnType<typeof fixture>) {
  const response = test.service.begin(beginRequest);
  const request = test.provider.requests.at(-1);
  if (request === undefined) throw new Error("No authorization request.");
  return { response, request };
}

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
