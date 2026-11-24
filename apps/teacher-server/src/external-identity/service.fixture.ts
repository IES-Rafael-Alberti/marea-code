/* eslint-disable @typescript-eslint/require-await */

import {
  type ExternalIdentity,
  type IdentityAuthorizationRequest,
  type IdentityAuthorizationResponse,
  type IdentityProvider,
} from "@marea/plugin-api";
import { ExternalAuthBeginRequestSchema, ExternalAuthCompleteRequestSchema } from "@marea/protocol";
import { expect } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type {
  ClassAdmissionRules,
  ExternalIdentityRepository,
  ExternalProvisioning,
} from "./contracts.js";
import { ExternalIdentityService, type ExternalIdentityServiceDependencies } from "./service.js";

export const PROVIDER_ID = "org.example.idp";
export const label = { es: "Centro", en: "School", eu: "Ikastetxea" };
export const PERSON: ExternalIdentity = {
  subject: "sub-1",
  email: "ana@school.test",
  displayName: "Ana",
};
export const ACCOUNT: AuthenticatedIdentity = {
  classId: null,
  displayName: "Ana",
  role: "student",
  userId: "user:ana",
};

class FakeProvider implements IdentityProvider {
  readonly requests: IdentityAuthorizationRequest[] = [];
  readonly responses: IdentityAuthorizationResponse[] = [];
  readonly admissions: string[] = [];
  readonly admissionSignals: AbortSignal[] = [];
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

  async admits(
    identity: ExternalIdentity,
    rules: ClassAdmissionRules["rules"],
    signal: AbortSignal,
  ): Promise<boolean> {
    this.admissionSignals.push(signal);
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

export function fixture(
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
  const budgets: number[] = [];
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
            budgets.push(milliseconds);
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
    budgets,
  };
}

export const envelope = { protocolVersion: "0.1" } as const;
export const beginRequest = ExternalAuthBeginRequestSchema.parse({
  ...envelope,
  kind: "external-auth-begin",
  requestId: "r:begin",
  providerId: PROVIDER_ID,
  redirectUri: "http://127.0.0.1:4321/callback",
});

export function completion(flowId: string, state: string, code = "4/code") {
  return ExternalAuthCompleteRequestSchema.parse({
    ...envelope,
    kind: "external-auth-complete",
    requestId: "r:complete",
    flowId,
    state,
    code,
  });
}

export function started(test: ReturnType<typeof fixture>) {
  const response = test.service.begin(beginRequest);
  const request = test.provider.requests.at(-1);
  if (request === undefined) throw new Error("No authorization request.");
  return { response, request };
}

export function completeStarted(test: ReturnType<typeof fixture>) {
  const { response, request } = started(test);
  return test.service.complete(completion(response.flowId, request.state));
}
