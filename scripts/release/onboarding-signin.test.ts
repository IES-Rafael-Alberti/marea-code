import { expect, it, vi } from "vitest";
import { onboardingSignIn } from "./onboarding-signin.boundary.js";
import { setupInput } from "./onboarding.fixture.js";
it("hands off the local HttpOnly session and consumes its response body", async () => {
  const response = new Response("private-body", {
    headers: { "set-cookie": "session=synthetic; HttpOnly" },
  });
  const cancel = vi.spyOn(response, "arrayBuffer");
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const input = setupInput();
  expect(await onboardingSignIn(input, fetch)).toBe("session=synthetic; HttpOnly");
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:18793/api/v1/dashboard/session/login",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:18793" },
      signal: expect.any(AbortSignal) as AbortSignal,
    }),
  );
  expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
    kind: "credential-login",
    protocolVersion: "0.1",
    requestId: expect.any(String) as string,
    credentials: { login: input.login, password: input.password },
  });
  expect(cancel).toHaveBeenCalledOnce();
});
it("never sends credentials to a remote HTTPS origin and tolerates a failed local sign-in", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(
    await onboardingSignIn(
      setupInput({ access: "https", publicOrigin: "https://school.test" }),
      fetch,
    ),
  ).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  for (const response of [
    new Response(null),
    new Response(null, { status: 401, headers: { "set-cookie": "must-not-forward" } }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    expect(await onboardingSignIn(setupInput(), fetch)).toBeUndefined();
  }
  fetch.mockRejectedValueOnce(new Error("private"));
  expect(await onboardingSignIn(setupInput(), fetch)).toBeUndefined();
});
it("uses the system fetch by default", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetch);
  try {
    await onboardingSignIn(setupInput());
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
