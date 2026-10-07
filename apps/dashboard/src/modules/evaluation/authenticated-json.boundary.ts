import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { EvaluationRequestError } from "./evaluation-client.boundary.js";

export async function authenticatedJsonRequest(
  fetchRequest: DashboardFetch,
  path: string,
  body: object,
  signal: AbortSignal,
) {
  const response = await fetchRequest(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new EvaluationRequestError(response.status);
  return response;
}
