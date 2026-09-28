import { expect, vi } from "vitest";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import type { TeachingProblem } from "./teaching-contracts.js";

export interface CapturedFetch {
  readonly fetchRequest: ReturnType<typeof vi.fn<DashboardFetch>>;
  readonly requests: CapturedRequest[];
}

export interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly request: Request;
}

export function captureFetch(response: () => Response | Promise<Response>): CapturedFetch {
  const requests: CapturedRequest[] = [];
  const fetchRequest = vi.fn<DashboardFetch>((url: string, init: RequestInit) => {
    const resolved = new URL(url, "http://dashboard.local").toString();
    const requestInit = { ...init };
    delete requestInit.cache;
    requests.push({
      url,
      init,
      request: new Request(resolved, requestInit),
    });
    return Promise.resolve(response());
  });
  return { fetchRequest, requests };
}

export async function expectProblem(
  promise: Promise<object>,
  code: TeachingProblem,
  message: string,
) {
  await expect(promise).rejects.toMatchObject({ code, message });
}
