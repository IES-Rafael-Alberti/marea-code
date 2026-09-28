/** Dashboard cookie POST policy shared by presentation clients. */
export function dashboardPost(body: object, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
