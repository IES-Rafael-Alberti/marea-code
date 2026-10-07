import { randomUUID } from "node:crypto";
import type { ServerSetupRequest } from "@marea/protocol";

/** Loopback setup and the local dashboard share a host cookie, even on different ports. */
export async function onboardingSignIn(
  input: ServerSetupRequest,
  fetchRequest = fetch,
): Promise<string | undefined> {
  // A remote HTTPS origin may name another host; never forward the teacher password there.
  if (input.access === "https") return undefined;
  let response: Response;
  try {
    response = await fetchRequest(
      `http://127.0.0.1:${String(input.port)}/api/v1/dashboard/session/login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${String(input.port)}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: randomUUID(),
          credentials: { login: input.login, password: input.password },
        }),
      },
    );
    await response.arrayBuffer();
  } catch {
    return undefined;
  }
  return response.ok ? (response.headers.get("set-cookie") ?? undefined) : undefined;
}
