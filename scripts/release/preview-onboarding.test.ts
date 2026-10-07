import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerSetupRequest } from "@marea/protocol";
import type { OnboardingHttpOptions } from "./onboarding-http.boundary.js";
import { setupInput } from "./onboarding.fixture.js";
const p = vi.hoisted(() => ({
  stdout: vi.fn(),
  stderr: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  securePrivatePath: vi.fn(),
  loadFileSystemDashboardAssets: vi.fn(),
  createDashboardAssetHandler: vi.fn(),
  openSystemBrowser: vi.fn(),
  assertPreviewServerReady: vi.fn(),
  existingOnboarding: vi.fn(),
  ownOnboarding: vi.fn(),
  close: vi.fn(),
  onboardingHttp: vi.fn(),
  onboardingSettings: vi.fn(),
  read: vi.fn(),
  models: vi.fn(),
  validate: vi.fn(),
  provisionOnboarding: vi.fn(),
  relocateOnboarding: vi.fn(),
  onboardingSignIn: vi.fn(),
  waitForOnboardingHost: vi.fn(),
  checkOnboardingPort: vi.fn(),
  serve: vi.fn(),
  stop: vi.fn(),
  find: vi.fn(),
}));
vi.mock("node:fs", () => p);
vi.mock("@marea/private-filesystem", () => p);
vi.mock(
  "../../apps/teacher-server/src/dashboard-assets/filesystem-dashboard-assets.boundary.js",
  () => p,
);
vi.mock("../../apps/teacher-server/src/dashboard-assets/dashboard-asset-handler.js", () => p);
vi.mock("../../apps/student/src/external-authorization.boundary.js", () => p);
vi.mock("./preview-server-update.boundary.js", () => p);
vi.mock("./onboarding-state.boundary.js", () => ({
  ...p,
  onboardingMarker: "onboarding-pending.json",
}));
vi.mock("./onboarding-http.boundary.js", () => p);
vi.mock("./onboarding-settings.boundary.js", () => p);
vi.mock("./onboarding-provision.boundary.js", () => p);
vi.mock("./onboarding-signin.boundary.js", () => p);
vi.mock("./onboarding-host.boundary.js", () => p);
import { runBrowserOnboarding } from "./preview-onboarding.boundary.js";
const settings = {
  format: 1 as const,
  repository: "school/marea",
  component: "server" as const,
  channel: "preview" as const,
  installation: "/root/installation",
};
const options = () => ({
  root: "/root",
  release: "/release",
  version: "0.1.0-preview.18",
  settings,
  run: vi.fn(),
  launch: vi.fn(() => Promise.resolve(0)),
  openBrowser: vi.fn(),
});
const handlers = () => p.onboardingHttp.mock.calls[0]?.[0] as OnboardingHttpOptions;
async function started(o = options()) {
  const running = runBrowserOnboarding(o);
  void running.catch(() => undefined);
  await vi.waitFor(() => {
    expect(o.openBrowser).toHaveBeenCalled();
  });
  return { running, o };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("Bun", { serve: p.serve });
  p.serve.mockReturnValue({ url: new URL("http://127.0.0.1:12345"), stop: p.stop });
  p.existingOnboarding.mockReturnValue(null);
  p.existsSync.mockReturnValue(false);
  p.lstatSync.mockReturnValue({ isFile: () => true });
  p.readFileSync.mockReturnValue("setup-html");
  p.loadFileSystemDashboardAssets.mockResolvedValue({ find: p.find });
  p.createDashboardAssetHandler.mockReturnValue(() => new Response("asset"));
  p.onboardingHttp.mockReturnValue(() => Promise.resolve(new Response("handled")));
  p.onboardingSettings.mockReturnValue({ read: p.read, models: p.models, validate: p.validate });
  p.ownOnboarding.mockReturnValue({ stage: "/root/.onboarding-scratch", close: p.close });
  p.validate.mockImplementation((input: ServerSetupRequest) =>
    Promise.resolve({
      request: input,
      settings: {},
      origin: input.access === "https" ? "https://school.test" : "http://127.0.0.1:18793",
    }),
  );
  p.stdout.mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockImplementation(p.stdout);
  p.stderr.mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockImplementation(p.stderr);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("reopens an existing setup process without creating another", async () => {
  p.existingOnboarding.mockReturnValue("http://127.0.0.1:1234/dashboard/setup.html#token=existing");
  const o = options();
  expect(await runBrowserOnboarding(o)).toBe(0);
  expect(o.openBrowser).toHaveBeenCalledWith(p.existingOnboarding.mock.results[0]?.value);
  expect(p.serve).not.toHaveBeenCalled();
  expect(p.stdout).toHaveBeenCalledWith(
    `El asistente ya está abierto: ${String(p.existingOnboarding.mock.results[0]?.value)}\n`,
  );
});
it.each([false, true])(
  "recovers a fully promoted school after marker removal was interrupted: %s",
  async (allowHttp) => {
    p.existsSync.mockReturnValue(true);
    const o = options();
    expect(await runBrowserOnboarding({ ...o, settings: { ...settings, allowHttp } })).toBe(0);
    expect(p.assertPreviewServerReady).toHaveBeenCalledWith(settings.installation);
    expect(p.rmSync).toHaveBeenCalledWith("/root/onboarding-pending.json");
    expect(o.launch).toHaveBeenCalledWith(allowHttp);
  },
);
it("refuses unexpected installation paths or a missing setup page", async () => {
  await expect(
    runBrowserOnboarding({ ...options(), settings: { ...settings, installation: "/elsewhere" } }),
  ).rejects.toThrow("Unexpected managed");
  p.lstatSync.mockReturnValue({ isFile: () => false });
  await expect(runBrowserOnboarding(options())).rejects.toThrow("Missing setup page");
  expect(p.serve).not.toHaveBeenCalled();
});
it("closes the local listener when it cannot take ownership", async () => {
  p.ownOnboarding.mockImplementation(() => {
    throw new Error("owner busy");
  });
  await expect(runBrowserOnboarding(options())).rejects.toThrow("owner busy");
  expect(p.stop).toHaveBeenCalledWith(true);
});
it.each([false, true])(
  "promotes a configured school, waits for readiness and hands off the dashboard, HTTPS=%s",
  async (https) => {
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const child = Promise.withResolvers<number>();
    const o = options();
    o.launch.mockReturnValue(child.promise);
    const { running } = await started(o);
    const h = handlers();
    expect(h.origin()).toBe("http://127.0.0.1:12345");
    expect(h.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(o.openBrowser).toHaveBeenCalledWith(
      `http://127.0.0.1:12345/dashboard/setup.html#token=${h.token}`,
    );
    expect(p.securePrivatePath).toHaveBeenCalledWith("/root/.onboarding-scratch", 0o700);
    const assets = p.createDashboardAssetHandler.mock.calls[0]?.[0] as {
      find: (name: string) => { body: Blob };
    };
    expect(await assets.find("setup.html").body.text()).toBe("setup-html");
    expect(assets.find("setup.html")).toMatchObject({
      contentType: "text/html; charset=utf-8",
      entityTag: '"setup"',
      immutable: false,
    });
    expect(p.loadFileSystemDashboardAssets).toHaveBeenCalledWith("/release/dashboard");
    expect(p.readFileSync).toHaveBeenCalledWith("/release/dashboard/setup.html");
    assets.find("other");
    expect(p.find).toHaveBeenCalledWith("other");
    const request = new Request("http://127.0.0.1:12345/dashboard/setup.html");
    expect(await (await h.assets(request)).text()).toBe("asset");
    await h.models({ query: true }, request.signal);
    expect(p.models).toHaveBeenCalledWith({ query: true }, request.signal);
    const serve = p.serve.mock.calls[0]?.[0] as { fetch: (r: Request) => Promise<Response> };
    expect(await (await serve.fetch(request)).text()).toBe("handled");
    expect(p.serve).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "127.0.0.1", port: 0, idleTimeout: 180 }),
    );
    const ready = Promise.withResolvers<undefined>();
    p.waitForOnboardingHost.mockReturnValue(ready.promise);
    p.onboardingSignIn.mockResolvedValue(https ? undefined : "session=cookie");
    const input = setupInput({ access: https ? "https" : "lan" });
    const finished = h.finish(input, new AbortController().signal);
    await vi.waitFor(() => {
      expect(o.launch).toHaveBeenCalledWith(!https);
    });
    expect(p.onboardingSignIn).not.toHaveBeenCalled();
    expect(p.checkOnboardingPort).toHaveBeenCalledWith(input.port, !https);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    ready.resolve(undefined);
    expect(await finished).toStrictEqual({
      dashboardUrl: https ? "https://school.test/dashboard/" : "http://127.0.0.1:18793/dashboard/",
      ...(https ? {} : { cookie: "session=cookie" }),
    });
    expect(p.provisionOnboarding).toHaveBeenCalledWith(
      "/root/.onboarding-scratch",
      "/release",
      "0.1.0-preview.18",
      expect.objectContaining({ request: input }),
      o.run,
    );
    expect(p.relocateOnboarding).toHaveBeenCalledWith(
      "/root/.onboarding-scratch",
      "/root/installation",
    );
    expect(p.rmSync).toHaveBeenCalledWith("/root/.onboarding-scratch", {
      recursive: true,
      force: true,
    });
    expect(p.writeFileSync.mock.calls[0]?.[0]).toMatch(/^\/root\/preview\.[0-9a-f-]+\.tmp$/u);
    expect(p.renameSync).toHaveBeenCalledWith(
      p.writeFileSync.mock.calls[0]?.[0],
      "/root/preview.json",
    );
    expect(p.stdout).toHaveBeenCalledWith(
      `Completa la configuración en tu navegador: ${String(o.openBrowser.mock.calls[0]?.[0])}\n`,
    );
    expect(p.stderr).toHaveBeenCalledWith(
      "Creando el centro, configurando el modelo y guardando la primera clase...\n",
    );
    expect(p.renameSync).toHaveBeenLastCalledWith(
      "/root/.onboarding-scratch",
      "/root/installation",
    );
    expect(p.rmSync).toHaveBeenCalledWith("/root/onboarding-pending.json");
    const written = JSON.parse(p.writeFileSync.mock.calls[0]?.[1] as string) as object;
    expect(written).toEqual({ ...settings, allowHttp: !https });
    expect(p.writeFileSync.mock.calls[0]?.[2]).toEqual({ flag: "wx", mode: 0o600 });
    await vi.waitFor(
      () => {
        expect(p.stop).toHaveBeenCalledWith(false);
      },
      { timeout: 2000 },
    );
    child.resolve(0);
    expect(await running).toBe(0);
    expect((p.waitForOnboardingHost.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    expect(p.close).toHaveBeenCalledOnce();
    expect(p.stop).toHaveBeenLastCalledWith(true);
  },
);
it.each(["SIGINT", "SIGTERM"] as const)(
  "cancels unfinished setup and permits a future attempt: %s",
  async (signal) => {
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const { running } = await started();
    process.emit(signal);
    await expect(running).rejects.toThrow("Configuración cancelada");
    expect(p.close).toHaveBeenCalledOnce();
    expect(p.provisionOnboarding).not.toHaveBeenCalled();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
  },
);
it("waits for in-flight provisioning to stop before deleting scratch", async () => {
  const provision = Promise.withResolvers<undefined>();
  p.provisionOnboarding.mockReturnValueOnce(provision.promise);
  const { running } = await started();
  const result = handlers().finish(setupInput(), new AbortController().signal);
  void result.catch(() => undefined);
  await vi.waitFor(() => {
    expect(p.provisionOnboarding).toHaveBeenCalledOnce();
  });
  process.emit("SIGINT");
  await Promise.resolve();
  expect(p.close).not.toHaveBeenCalled();
  provision.resolve(undefined);
  await expect(result).rejects.toThrow();
  await expect(running).rejects.toThrow("cancelada");
  expect(p.renameSync).not.toHaveBeenCalled();
  expect(p.close).toHaveBeenCalledOnce();
});
it("keeps setup pending after a failed attempt or unexpected destination", async () => {
  const { running } = await started();
  p.provisionOnboarding.mockRejectedValueOnce(new Error("provision failed"));
  await expect(handlers().finish(setupInput(), new AbortController().signal)).rejects.toThrow(
    "provision failed",
  );
  p.existsSync.mockReturnValue(true);
  await expect(handlers().finish(setupInput(), new AbortController().signal)).rejects.toThrow(
    "Installation appeared",
  );
  expect(p.renameSync).not.toHaveBeenCalled();
  process.emit("SIGTERM");
  await expect(running).rejects.toThrow("cancelada");
});
it("reports host startup failure to the pending page and preserves the completed installation", async () => {
  p.waitForOnboardingHost.mockRejectedValue(new Error("host-failed"));
  const child = Promise.withResolvers<number>();
  const o = options();
  o.launch.mockReturnValue(child.promise);
  const { running } = await started(o);
  await expect(handlers().finish(setupInput(), new AbortController().signal)).rejects.toThrow(
    "host-failed",
  );
  child.resolve(5);
  expect(await running).toBe(5);
  expect(p.renameSync).toHaveBeenCalled();
  expect(p.rmSync).not.toHaveBeenCalledWith("/root/installation", expect.anything());
});
it("uses the system browser by default", async () => {
  p.existingOnboarding.mockReturnValue("existing");
  const o: Parameters<typeof runBrowserOnboarding>[0] = options();
  delete o.openBrowser;
  await runBrowserOnboarding(o);
  expect(p.openSystemBrowser).toHaveBeenCalledWith("existing");
});
it("cleans up after the child rejects while the readiness probe is still running", async () => {
  const child = Promise.withResolvers<number>();
  const ready = Promise.withResolvers<undefined>();
  p.waitForOnboardingHost.mockReturnValueOnce(ready.promise);
  const o = options();
  o.launch.mockReturnValue(child.promise);
  const { running } = await started(o);
  const result = handlers().finish(setupInput(), new AbortController().signal);
  void result.catch(() => undefined);
  await vi.waitFor(() => {
    expect(o.launch).toHaveBeenCalled();
  });
  child.reject(new Error("spawn failed"));
  ready.reject(new Error("host-stopped"));
  await expect(result).rejects.toThrow("host-stopped");
  await expect(running).rejects.toThrow("spawn failed");
  expect(p.close).toHaveBeenCalledOnce();
});
it("cancels before provisioning when interrupted during port validation", async () => {
  const port = Promise.withResolvers<undefined>();
  p.checkOnboardingPort.mockReturnValueOnce(port.promise);
  const { running } = await started();
  const result = handlers().finish(setupInput(), new AbortController().signal);
  void result.catch(() => undefined);
  await vi.waitFor(() => {
    expect(p.checkOnboardingPort).toHaveBeenCalled();
  });
  process.emit("SIGTERM");
  expect((p.validate.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
  port.resolve(undefined);
  await expect(result).rejects.toThrow();
  await expect(running).rejects.toThrow("cancelada");
  expect(p.provisionOnboarding).not.toHaveBeenCalled();
});
