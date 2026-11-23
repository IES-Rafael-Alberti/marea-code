import {
  CURRENT_PROTOCOL_VERSION,
  type ClassBootstrapResponse,
  type ExternalAuthProvider,
  type IdentityProviderId,
  type SessionToken,
} from "@marea/protocol";

import { StudentHttpError } from "./http-error.js";
import type {
  AuthenticationResult,
  ClassPreferenceStore,
  ExternalAuthorization,
  IdSource,
  SelectableClass,
  StudentInterface,
  StudentServer,
} from "./contracts.js";

export interface SignInOptions {
  readonly classPreference?: ClassPreferenceStore;
  readonly externalAuthorization?: ExternalAuthorization | undefined;
  readonly ids: IdSource;
  readonly server: StudentServer;
  readonly studentInterface: StudentInterface;
  /** Test seam: the delay between completion retries. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam: the jitter source for completion retry backoff, in [0, 1). */
  readonly retryJitter?: () => number;
}

const MAX_COMPLETION_ATTEMPTS = 3;
const COMPLETION_RETRY_BASE_DELAY_MS = 1_000;
const COMPLETION_RETRY_JITTER_MS = 500;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function completionRetryDelay(attempt: number, jitter: () => number): number {
  return (
    COMPLETION_RETRY_BASE_DELAY_MS * 2 ** attempt +
    Math.floor(jitter() * COMPLETION_RETRY_JITTER_MS)
  );
}

async function completeWithRetry(
  completeExternal: NonNullable<StudentServer["completeExternal"]>,
  request: Parameters<NonNullable<StudentServer["completeExternal"]>>[0],
  sleep: (milliseconds: number) => Promise<void>,
  jitter: () => number,
): ReturnType<NonNullable<StudentServer["completeExternal"]>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await completeExternal(request);
    } catch (error) {
      // auth.busy surfaces as a retryable 503 on the completion endpoint; a 401
      // auth.invalid is never retried because the flow was already consumed.
      const busy = error instanceof StudentHttpError && error.status === 503 && error.retryable;
      if (!busy || attempt + 1 >= MAX_COMPLETION_ATTEMPTS) throw error;
      await sleep(completionRetryDelay(attempt, jitter));
    }
  }
}

/** Providers are offered only by a server that announces them; a failure hides them. */
export async function discoverProviders(
  options: SignInOptions,
  announced: boolean,
): Promise<readonly ExternalAuthProvider[]> {
  const discover = options.server.externalProviders?.bind(options.server);
  // Stryker disable next-line ConditionalExpression: calling a missing method fails and is caught as "no providers".
  if (!announced || discover === undefined) return [];
  try {
    const requestId = options.ids.request();
    const response = await discover({
      kind: "external-auth-providers-query",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
    });
    return response.requestId === requestId ? response.providers : [];
  } catch {
    return [];
  }
}

/** Runs the provider sign-in in the student's browser and exchanges its answer for a session. */
export async function exchangeExternal(
  options: SignInOptions,
  providerId: IdentityProviderId,
): Promise<SessionToken> {
  const { server } = options;
  const beginExternal = server.beginExternal?.bind(server);
  const completeExternal = server.completeExternal?.bind(server);
  const authorization = options.externalAuthorization;
  if (beginExternal === undefined || completeExternal === undefined || authorization === undefined)
    throw new Error("External sign-in is unavailable in this Marea client.");
  let flowId: string | undefined;
  const callback = await authorization.authorize(async (redirectUri) => {
    const started = await beginExternal({
      kind: "external-auth-begin",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: options.ids.request(),
      providerId,
      redirectUri,
    });
    flowId = started.flowId;
    return { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt };
  });
  if (flowId === undefined) throw new Error("The external sign-in did not start.");
  const response = await completeWithRetry(
    completeExternal,
    {
      kind: "external-auth-complete",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: options.ids.request(),
      flowId,
      state: callback.state,
      code: callback.code,
    },
    options.sleep ?? defaultSleep,
    options.retryJitter ?? Math.random,
  );
  return response.session.token;
}

async function chooseClass(
  options: SignInOptions,
  classes: readonly SelectableClass[],
): Promise<string> {
  const [only, ...others] = classes;
  // Stryker disable next-line ConditionalExpression: the protocol always lists at least one class.
  if (only !== undefined && others.length === 0) return only.classId;
  const remembered = await options.classPreference?.load();
  return classes.some((entry) => entry.classId === remembered)
    ? String(remembered)
    : options.studentInterface.chooseClass(classes);
}

/** Bootstraps the session's class, first binding a session that names none to a chosen one. */
export async function bootstrapClass(
  options: SignInOptions,
  token: SessionToken,
): Promise<AuthenticationResult<ClassBootstrapResponse>> {
  const result = await options.server.bootstrap(token, {
    kind: "class-bootstrap",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: options.ids.request(),
  });
  if (!result.authenticated) return result;
  const outcome = result.value;
  if (outcome.kind === "class-bootstrapped") return { authenticated: true, value: outcome };
  const classId = await chooseClass(options, outcome.classes);
  const selected = await options.server.selectClass(token, {
    kind: "class-select",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: options.ids.request(),
    classId,
  });
  if (selected.authenticated) await options.classPreference?.save(classId);
  return selected;
}
