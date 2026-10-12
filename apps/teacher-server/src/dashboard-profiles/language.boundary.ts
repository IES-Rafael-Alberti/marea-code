import {
  createDashboardProfileDocumentSchema,
  DashboardLanguageRequestSchema,
  DashboardLanguageResponseSchema,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { DashboardProfileError, type DashboardProfileStore } from "./contracts.js";

/** Resolves the owner from authentication; requests cannot name another teacher or a class. */
export function dashboardLanguage(
  identity: AuthenticatedIdentity,
  bytes: Uint8Array,
  profiles: Pick<DashboardProfileStore, "transaction" | "authorized">,
  language: { read(ownerId: string): string | null; write(ownerId: string, value: string): void },
): object {
  const parsed = createDashboardProfileDocumentSchema(
    DashboardLanguageRequestSchema,
    "request",
  ).safeParse(bytes);
  if (!parsed.success) throw new DashboardProfileError(400);
  const request = parsed.data;
  try {
    return profiles.transaction(() => {
      if (identity.role !== "teacher" || !profiles.authorized(identity.userId, null))
        throw new DashboardProfileError(403);
      if (request.kind === "save") language.write(identity.userId, request.preference);
      return DashboardLanguageResponseSchema.parse({
        protocolVersion: request.protocolVersion,
        requestId: request.requestId,
        preference: language.read(identity.userId),
      });
    });
  } catch (error) {
    throw new DashboardProfileError(
      error instanceof DashboardProfileError ? error.status : 500,
      request.requestId,
    );
  }
}
