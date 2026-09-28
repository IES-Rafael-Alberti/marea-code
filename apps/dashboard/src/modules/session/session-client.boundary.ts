import {
  CredentialLoginRequestSchema,
  CredentialLogoutRequestSchema,
  CredentialLogoutResponseSchema,
  DashboardSessionQuerySchema,
  DashboardSessionResponseSchema,
} from "@marea/protocol";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

type SessionCheck =
  | { readonly status: "signed-in"; readonly displayName: string }
  | { readonly status: "signed-out" };

type SignInResult =
  | { readonly status: "signed-in"; readonly displayName: string }
  | { readonly status: "invalid" }
  | { readonly status: "not-teacher" };

/** The dashboard's teacher session. The token lives only in the server's HttpOnly cookie. */
export interface DashboardSessionClient {
  current(signal: AbortSignal): Promise<SessionCheck>;
  signIn(login: string, password: string, signal: AbortSignal): Promise<SignInResult>;
  signOut(signal: AbortSignal): Promise<void>;
}

const SESSION_PATH = "/api/v1/dashboard/session";

export function createDashboardSessionClient(
  fetchRequest: DashboardFetch,
  createId: () => string = () => `request:${crypto.randomUUID()}`,
): DashboardSessionClient {
  const envelope = () => ({ protocolVersion: "0.1", requestId: createId() });
  const post = (path: string, body: object, signal: AbortSignal) =>
    fetchRequest(`${SESSION_PATH}${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const signedIn = async (response: Response, requestId: string) => {
    const session = DashboardSessionResponseSchema.parse(await response.json());
    if (session.requestId !== requestId)
      throw new Error("The session response does not match its request.");
    return { status: "signed-in", displayName: session.principal.displayName } as const;
  };
  const unavailable = () => new Error("The session service is unavailable.");
  return Object.freeze<DashboardSessionClient>({
    async current(signal) {
      const query = DashboardSessionQuerySchema.parse({
        ...envelope(),
        kind: "dashboard-session-query",
      });
      const response = await post("", query, signal);
      if (response.status === 401 || response.status === 403) return { status: "signed-out" };
      if (!response.ok) throw unavailable();
      return signedIn(response, query.requestId);
    },
    async signIn(login, password, signal) {
      const parsed = CredentialLoginRequestSchema.safeParse({
        ...envelope(),
        kind: "credential-login",
        credentials: { login: login.trim().toLowerCase(), password },
      });
      // A login or password the server could never accept is reported like wrong credentials.
      if (!parsed.success) return { status: "invalid" };
      const response = await post("/login", parsed.data, signal);
      if (response.status === 401 || response.status === 400) return { status: "invalid" };
      if (response.status === 403) return { status: "not-teacher" };
      if (!response.ok) throw unavailable();
      return signedIn(response, parsed.data.requestId);
    },
    async signOut(signal) {
      const request = CredentialLogoutRequestSchema.parse({
        ...envelope(),
        kind: "credential-logout",
      });
      const response = await post("/logout", request, signal);
      // An already expired session is signed out as well.
      if (response.status === 401) return;
      if (!response.ok) throw unavailable();
      CredentialLogoutResponseSchema.parse(await response.json());
    },
  });
}
