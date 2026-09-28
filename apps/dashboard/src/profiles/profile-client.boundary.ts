import { dashboardPost } from "../dashboard-post.js";
import {
  createDashboardProfileDocumentSchema,
  MAX_DASHBOARD_PROFILE_RESPONSE_BYTES,
  MAX_DASHBOARD_PROFILE_REQUEST_BYTES,
  DashboardCatalogRevisionSchema,
} from "@marea/protocol";
import * as z from "zod";
import type { DashboardProfileScope } from "@marea/protocol";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";
import type { ProfileCatalog, ProfileValue } from "./profile-catalog.js";

export class ProfileCatalogMismatchError extends Error {}
export class LegacyProfileModeError extends Error {}

export class ProfileRequestError extends Error {
  constructor(readonly status: number) {
    super("Profile request failed.");
  }
}
export interface ProfileWrite {
  readonly scope: DashboardProfileScope;
  readonly expectedRevision: string | null;
  readonly expectedPersonalRevision: string | null;
  readonly catalogRevision: string;
}
export function createProfileClient(
  fetchRequest: DashboardFetch,
  release: ProfileCatalog,
  createId: () => string = () => `request:${crypto.randomUUID()}`,
) {
  async function post<T extends { requestId: string; scope: DashboardProfileScope }>(
    operation: "read" | "catalog" | "save" | "reset",
    scope: DashboardProfileScope,
    schema: z.ZodType<T>,
    fields: object,
    signal: AbortSignal,
  ): Promise<T> {
    const body = release.schemas.request.parse({
      protocolVersion: "0.1",
      requestId: createId(),
      kind: `dashboard-profile-${operation}`,
      scope,
      ...fields,
    });
    validateProfileRequestSize(body);
    const response = await fetchRequest(
      `/api/v1/dashboard/profiles/${operation}`,
      dashboardPost(body, signal),
    );
    if (response.status === 503 && response.headers.get("x-marea-profile-mode") === "legacy")
      throw new LegacyProfileModeError();
    if (!response.ok) throw new ProfileRequestError(response.status);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing profile response.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_DASHBOARD_PROFILE_RESPONSE_BYTES)
          throw new Error("Profile response too large.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const document = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      document.set(chunk, offset);
      offset += chunk.length;
    }
    const header = createDashboardProfileDocumentSchema(
      z.object({ catalogRevision: DashboardCatalogRevisionSchema }),
      "response",
    ).parse(document);
    if (header.catalogRevision !== release.revision)
      throw new ProfileCatalogMismatchError("Different dashboard catalog.");
    const parsed = createDashboardProfileDocumentSchema(schema, "response").parse(document);
    if (
      parsed.requestId !== body.requestId ||
      JSON.stringify(parsed.scope) !== JSON.stringify(scope)
    )
      throw new Error("Profile response mismatch.");
    return parsed;
  }
  return {
    read: (scope: DashboardProfileScope, signal: AbortSignal) =>
      post("read", scope, release.schemas.state, {}, signal),
    catalog: (scope: DashboardProfileScope, signal: AbortSignal) =>
      post("catalog", scope, release.catalog, {}, signal),
    save: (
      write: ProfileWrite,
      value: ProfileValue,
      discardUnavailable: boolean,
      signal: AbortSignal,
    ) =>
      post(
        "save",
        write.scope,
        release.schemas.state,
        { ...write, value, discardUnavailable },
        signal,
      ),
    reset: (write: ProfileWrite, signal: AbortSignal) =>
      post("reset", write.scope, release.schemas.state, write, signal),
  };
}
export type ProfileClient = ReturnType<typeof createProfileClient>;

export function validateProfileRequestSize(body: object): void {
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_DASHBOARD_PROFILE_REQUEST_BYTES
  )
    throw new Error("Profile request too large.");
}
