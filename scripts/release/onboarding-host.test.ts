import { createServer } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ read: vi.fn(), config: vi.fn(), delay: vi.fn() }));
vi.mock("../../apps/teacher-server/src/platform/teacher-host/host-status.boundary.js", () => ({
  createFileHostStatus: () => ({ read: ports.read }),
}));
vi.mock("../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js", () => ({
  readTeacherHostConfig: ports.config,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: ports.delay }));
import { checkOnboardingPort, waitForOnboardingHost } from "./onboarding-host.boundary.js";
const origin = "https://school.test:8443/dashboard/";
const signal = () => new AbortController().signal;
const response = (requestId: string) =>
  Response.json({
    requestId,
    serverVersion: "0.1.0-preview.18",
    supportedProtocolVersions: ["0.1"],
    capabilities: [],
  });
beforeEach(() => {
  vi.resetAllMocks();
  ports.config.mockReturnValue({ listen: { port: 18793 } });
  ports.read.mockResolvedValue({ status: "ready" });
  ports.delay.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([false, true])("preflights the actual bind address, lan=%s", async (lan) => {
  await expect(checkOnboardingPort(0, lan)).resolves.toBeUndefined();
});
it("does not claim an already occupied port", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    const address = listener.address();
    if (typeof address !== "object" || address === null) throw new Error("missing address");
    await expect(checkOnboardingPort(address.port, false)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  } finally {
    await new Promise<void>((resolve) =>
      listener.close(() => {
        resolve();
      }),
    );
  }
});
it("waits for an actual protocol response after the ready status file", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new Error("not listening yet"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(response("wrong-request"));
  fetch.mockImplementation((_url, init) =>
    Promise.resolve(
      response((JSON.parse(init?.body as string) as { requestId: string }).requestId),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  ports.read.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: "starting" });
  await waitForOnboardingHost("/private", origin, signal());
  expect(ports.delay).toHaveBeenCalledTimes(5);
  expect(ports.delay).toHaveBeenCalledWith(200);
  expect(ports.read).toHaveBeenCalledWith({
    installationRoot: "/private",
    statusPath: "/private/state/host-status.json",
  });
  expect(ports.config).toHaveBeenCalledWith("/private");
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch).toHaveBeenLastCalledWith(
    "http://127.0.0.1:18793/v1/capabilities",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", host: "school.test:8443" },
      signal: expect.any(AbortSignal) as AbortSignal,
    }),
  );
  expect(JSON.parse(fetch.mock.lastCall?.[1]?.body as string)).toEqual({
    requestId: expect.any(String) as string,
    clientVersion: "0.1.0",
    supportedProtocolVersions: ["0.1"],
  });
});
it("reports a stopped, failed or timed-out host", async () => {
  const stopped = new AbortController();
  stopped.abort();
  await expect(waitForOnboardingHost("/private", origin, stopped.signal)).rejects.toThrow(
    "host-stopped",
  );
  ports.read.mockResolvedValueOnce({ status: "failed" });
  await expect(waitForOnboardingHost("/private", origin, signal())).rejects.toThrow("host-failed");
  vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValue(60100);
  await expect(waitForOnboardingHost("/private", origin, signal())).rejects.toThrow(
    "host-start-timeout",
  );
});
it("propagates cancellation to the active readiness request", async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    return Promise.reject(new Error("stopped"));
  });
  vi.stubGlobal("fetch", fetch);
  await expect(waitForOnboardingHost("/private", origin, controller.signal)).rejects.toThrow(
    "host-stopped",
  );
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it.each([false, true])("checks binding explicitly: %s", async (lan) => {
  const spy = vi.spyOn((await import("node:net")).Server.prototype, "listen");
  await checkOnboardingPort(0, lan);
  expect(spy).toHaveBeenCalledWith(0, lan ? "0.0.0.0" : "127.0.0.1", expect.any(Function));
  spy.mockRestore();
});
