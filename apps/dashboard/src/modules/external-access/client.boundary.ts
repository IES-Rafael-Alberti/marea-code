import {
  EXTERNAL_ACCESS_PATH,
  ExternalAccessRequestSchema,
  ExternalAccessResponseSchema,
  type ExternalAccessRequest,
  type ExternalAccessResponse,
} from "@marea/protocol";

import { readBoundedJson } from "../../bounded-json.boundary.js";
import { dashboardPost } from "../../dashboard-post.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";

const MAX_EXTERNAL_ACCESS_BYTES = 262_144;

/** The HTTP status of a refused request; 0 when the answer itself was unusable. */
export class ExternalAccessError extends Error {
  constructor(readonly status: number) {
    super("External access is unavailable.");
  }
}

export async function externalAccessRequest(
  fetchRequest: DashboardFetch,
  request: ExternalAccessRequest,
  signal: AbortSignal,
): Promise<ExternalAccessResponse> {
  const body = ExternalAccessRequestSchema.parse(request);
  const response = await fetchRequest(EXTERNAL_ACCESS_PATH, dashboardPost(body, signal));
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new ExternalAccessError(response.ok ? 0 : response.status);
  }
  const result = ExternalAccessResponseSchema.parse(
    await readBoundedJson(response.body, MAX_EXTERNAL_ACCESS_BYTES),
  );
  if (result.requestId !== body.requestId || result.classId !== body.classId)
    throw new ExternalAccessError(0);
  return result;
}

export type ExternalAccessOutcome =
  | { readonly ok: true; readonly value: ExternalAccessResponse }
  | { readonly ok: false; readonly reason: "missing" | "conflict" | "error" };

/** A server without identity providers has no such endpoint: the view then shows nothing. */
export async function externalAccess(
  fetchRequest: DashboardFetch,
  request: ExternalAccessRequest,
  signal: AbortSignal,
): Promise<ExternalAccessOutcome> {
  try {
    return { ok: true, value: await externalAccessRequest(fetchRequest, request, signal) };
  } catch (error) {
    const status = error instanceof ExternalAccessError ? error.status : 0;
    return {
      ok: false,
      reason: status === 404 ? "missing" : status === 409 ? "conflict" : "error",
    };
  }
}
