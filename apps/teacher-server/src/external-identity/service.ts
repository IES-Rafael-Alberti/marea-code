import { createHash, timingSafeEqual } from "node:crypto";

import { IdentityProviderError, type ExternalIdentity } from "@marea/plugin-api";
import {
  CURRENT_PROTOCOL_VERSION,
  ExternalAuthBeginResponseSchema,
  ExternalAuthCompleteResponseSchema,
  ExternalAuthProvidersResponseSchema,
  SafeDisplayNameSchema,
  type ExternalAuthBeginRequest,
  type ExternalAuthBeginResponse,
  type ExternalAuthCompleteRequest,
  type ExternalAuthCompleteResponse,
  type ExternalAuthProvidersRequest,
  type ExternalAuthProvidersResponse,
} from "@marea/protocol";

import type { Clock, IdGenerator, SecretIssuer } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type {
  ConfiguredIdentityProvider,
  ExternalIdentityRepository,
  ExternalSessionIssuer,
} from "./contracts.js";

const FLOW_DURATION_MS = 10 * 60 * 1_000;
const MAX_PENDING_FLOWS = 256;
const MAX_CONCURRENT_COMPLETIONS = 4;
const PROVIDER_TIMEOUT_MS = 20_000;

interface PendingFlow {
  readonly provider: ConfiguredIdentityProvider;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly expiresAt: number;
}

export interface ExternalIdentityServiceDependencies {
  readonly providers: readonly ConfiguredIdentityProvider[];
  readonly repository: ExternalIdentityRepository;
  readonly sessions: ExternalSessionIssuer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly secrets: SecretIssuer;
  readonly timeout?: (milliseconds: number) => AbortSignal;
}

function sameSecret(left: string, right: string): boolean {
  const expected = Buffer.from(left);
  const actual = Buffer.from(right);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

/** Never shown as a password login: lowercase, bounded and derived from the provider subject. */
export function externalLogin(providerId: string, subject: string): string {
  return `x-${createHash("sha256").update(`${providerId}\0${subject}`).digest("hex").slice(0, 32)}`;
}

/** The provider name when it is a safe display name, then the address' local part, then a role. */
export function externalDisplayName(identity: ExternalIdentity): string {
  for (const candidate of [identity.displayName, identity.email.split("@")[0]]) {
    const parsed = SafeDisplayNameSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return "Student";
}

/**
 * Student sign-in through installed identity providers. Flows live in memory only, are single
 * use and expire; every provider answer is verified by the plugin before any account exists.
 */
export class ExternalIdentityService {
  readonly #dependencies: ExternalIdentityServiceDependencies;
  readonly #flows = new Map<string, PendingFlow>();
  #completing = 0;

  public constructor(dependencies: ExternalIdentityServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public enabled(): boolean {
    return this.#dependencies.providers.length > 0 && this.#dependencies.repository.available();
  }

  public providers(request: ExternalAuthProvidersRequest): ExternalAuthProvidersResponse {
    return ExternalAuthProvidersResponseSchema.parse({
      kind: "external-auth-providers",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      providers: this.enabled()
        ? this.#dependencies.providers.map(({ id, descriptor }) => ({
            providerId: id,
            displayName: descriptor.displayName,
          }))
        : [],
    });
  }

  public begin(request: ExternalAuthBeginRequest): ExternalAuthBeginResponse {
    const provider = this.#dependencies.providers.find(({ id }) => id === request.providerId);
    if (provider === undefined || !this.enabled()) throw new TeacherDomainError("request.conflict");
    const now = Date.parse(this.#dependencies.clock.now());
    for (const [flowId, flow] of this.#flows) if (flow.expiresAt <= now) this.#flows.delete(flowId);
    if (this.#flows.size >= MAX_PENDING_FLOWS) throw new TeacherDomainError("auth.busy");
    const { secrets } = this.#dependencies;
    const flowId = secrets.issue();
    const flow: PendingFlow = {
      provider,
      redirectUri: request.redirectUri,
      state: secrets.issue(),
      nonce: secrets.issue(),
      verifier: secrets.issue(),
      expiresAt: now + FLOW_DURATION_MS,
    };
    this.#flows.set(flowId, flow);
    return ExternalAuthBeginResponseSchema.parse({
      kind: "external-auth-started",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      flowId,
      authorizationUrl: provider.provider.authorizationUrl({
        redirectUri: flow.redirectUri,
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: createHash("sha256").update(flow.verifier).digest("base64url"),
      }),
      expiresAt: new Date(flow.expiresAt).toISOString(),
    });
  }

  public async complete(
    request: ExternalAuthCompleteRequest,
  ): Promise<ExternalAuthCompleteResponse> {
    const flow = this.#flows.get(request.flowId);
    this.#flows.delete(request.flowId);
    if (
      flow === undefined ||
      flow.expiresAt <= Date.parse(this.#dependencies.clock.now()) ||
      !sameSecret(flow.state, request.state)
    )
      throw new TeacherDomainError("auth.invalid");
    if (this.#completing >= MAX_CONCURRENT_COMPLETIONS) throw new TeacherDomainError("auth.busy");
    this.#completing += 1;
    try {
      const identity = await this.verifiedAccount(flow, request.code);
      const opened = this.#dependencies.sessions.openExternalSession(identity);
      return ExternalAuthCompleteResponseSchema.parse({
        kind: "external-authenticated",
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        principal: opened.principal,
        session: opened.session,
      });
    } finally {
      this.#completing -= 1;
    }
  }

  private async verifiedAccount(flow: PendingFlow, code: string) {
    const timeout =
      this.#dependencies.timeout ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
    const signal = timeout(PROVIDER_TIMEOUT_MS);
    const { provider, id } = flow.provider;
    try {
      const person = await provider.complete({
        code,
        redirectUri: flow.redirectUri,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
        signal,
      });
      const admitted: string[] = [];
      for (const { classId, rules } of this.#dependencies.repository.classRules(id))
        if (await provider.admits(person, rules, signal)) admitted.push(classId);
      const account = this.#dependencies.repository.provision({
        providerId: id,
        subject: person.subject,
        email: person.email,
        displayName: externalDisplayName(person),
        admittedClassIds: admitted,
        newUserId: this.#dependencies.ids.createId("user"),
        newLogin: externalLogin(id, person.subject),
        version: this.#dependencies.ids.createId("revision"),
        now: this.#dependencies.clock.now(),
      });
      if (account === undefined) throw new TeacherDomainError("auth.invalid");
      return account;
    } catch (error) {
      if (error instanceof IdentityProviderError)
        throw new TeacherDomainError(error.code === "unavailable" ? "auth.busy" : "auth.invalid");
      throw error;
    }
  }
}
