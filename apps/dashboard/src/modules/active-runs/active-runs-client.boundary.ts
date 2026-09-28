import {
  ActiveRunDashboardResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  RequestIdSchema,
  type ActiveRunDashboardResponse,
} from "@marea/protocol";

export type DashboardFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ActiveRunsClient {
  load(signal: AbortSignal): Promise<ActiveRunDashboardResponse>;
}

function activeRunsPath(): string {
  return "/api/v1/dashboard/active-runs";
}

function browserRequestId(): string {
  return `request:${crypto.randomUUID()}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function createActiveRunsClient(
  fetchRequest: DashboardFetch,
  createRequestId: () => string = browserRequestId,
): ActiveRunsClient {
  return Object.freeze({
    async load(signal: AbortSignal): Promise<ActiveRunDashboardResponse> {
      const requestId = RequestIdSchema.parse(createRequestId());
      const query = new URLSearchParams({
        kind: "active-runs-query",
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId,
        limit: "50",
      });
      const response = await fetchRequest(`${activeRunsPath()}?${query.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "GET",
        signal,
      });
      if (!response.ok) {
        throw new Error("The active runs request failed.");
      }
      return ActiveRunDashboardResponseSchema.parse(parseJson(await response.text()));
    },
  });
}
