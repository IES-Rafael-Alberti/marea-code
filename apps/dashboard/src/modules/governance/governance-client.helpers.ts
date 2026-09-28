import type { GovernanceClientFailure, GovernanceProblem } from "./governance-contracts.js";

export interface RequestWithEnvelope {
  readonly kind: string;
  readonly requestId: string;
}

export interface ResponseWithEnvelope {
  readonly kind: string;
  readonly requestId: string;
}

function isBinaryAfter(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const leftBytes = String.fromCharCode(...a);
  const rightBytes = String.fromCharCode(...b);
  return leftBytes > rightBytes;
}

export function pageIsValid<T>(
  response: { readonly items: readonly T[]; readonly nextAfterId: string | null },
  afterId: string | null,
  idOf: (item: T) => string,
  scope?: (item: T) => boolean,
): boolean {
  let previous = afterId;
  for (const item of response.items) {
    const id = idOf(item);
    if (
      (previous !== null && !isBinaryAfter(id, previous)) ||
      (scope !== undefined && !scope(item))
    )
      return false;
    previous = id;
  }
  if (response.nextAfterId === null) return true;
  if (previous !== null && !isBinaryAfter(response.nextAfterId, previous)) return false;
  return true;
}

export function statusProblem(status: number, mutation: boolean): GovernanceProblem {
  if (status === 400 || status === 413) return "invalid";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 422) return "skill-unavailable";
  if (status === 503) return "unconfigured";
  return mutation && status >= 500 ? "uncertain" : "load";
}

export function transportProblem(mutation: boolean, signal: AbortSignal): GovernanceProblem {
  return mutation || signal.aborted ? "uncertain" : "load";
}

export function governanceFailure(
  code: GovernanceProblem,
  message: string,
): GovernanceClientFailure {
  return Object.assign(new Error(message), { code });
}
