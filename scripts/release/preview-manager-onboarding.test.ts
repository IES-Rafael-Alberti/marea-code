import { expect, it, vi } from "vitest";
import { managerPorts, state } from "./preview-manager.fixture.js";
import { previewMain, runPrivateCommand } from "./preview-manager.boundary.js";
import type { InstallPorts } from "./install.boundary.js";
const ports = managerPorts();
const run = (selected: string, extra: string[] = []) => [
  "run",
  selected,
  "--root",
  "/private",
  "--",
  ...extra,
];
const install = (selected: string) => [
  "install",
  selected,
  "--root",
  "/private",
  "--repository",
  "school/marea",
  "--version",
  "0.1.0-preview.1",
  "--cosign",
  "/verified/cosign",
];
it("runs the first-start browser setup before update checks and forwards the persisted HTTP choice", async () => {
  state.selected = "server";
  ports.onboardingPending.mockReturnValue(true);
  ports.runBrowserOnboarding.mockImplementationOnce(
    async (options: { launch: (allowHttp: boolean) => Promise<number> }) => options.launch(true),
  );
  await previewMain(run("server"));
  expect(ports.offeredVersion).not.toHaveBeenCalled();
  expect(ports.runBrowserOnboarding).toHaveBeenCalledWith(
    expect.objectContaining({ root: "/private", version: state.version, run: runPrivateCommand }),
  );
  expect(ports.runForeground).toHaveBeenCalledWith(
    expect.any(String),
    ["--installation", "/private/installation", "--release", "release:preview", "--allow-http"],
    expect.any(Object),
  );
});
it("does not duplicate an explicit HTTP flag or back up a school that has not been created", async () => {
  state.selected = "server";
  ports.onboardingPending.mockReturnValue(true);
  ports.runBrowserOnboarding.mockImplementationOnce(
    async (options: { launch: (allowHttp: boolean) => Promise<number> }) => options.launch(true),
  );
  await previewMain(run("server", ["--allow-http"]));
  expect(ports.runForeground.mock.calls[0]?.[1]).toEqual([
    "--installation",
    "/private/installation",
    "--release",
    "release:preview",
    "--allow-http",
  ]);
  await previewMain(install("server"));
  const installer = ports.installRelease.mock.calls[0]?.[1] as InstallPorts;
  const activate = vi.fn(() => Promise.resolve());
  await installer.withOfflineBackup(activate);
  expect(activate).toHaveBeenCalledOnce();
  expect(ports.activatePreviewServer).not.toHaveBeenCalled();
  ports.existsSync.mockReturnValue(true);
  await installer.withOfflineBackup(activate);
  expect(ports.activatePreviewServer).toHaveBeenCalled();
});
it("remembers classroom HTTP on an ordinary restart and allows updating before setup", async () => {
  state.selected = "server";
  state.allowHttp = true;
  await previewMain(run("server"));
  expect(ports.runForeground.mock.calls[0]?.[1]).toContain("--allow-http");
  ports.onboardingPending.mockReturnValue(true);
  await previewMain(run("server", ["update"]));
  expect(ports.runBrowserOnboarding).not.toHaveBeenCalled();
});
it("does not interpret a student installation as an unfinished school", async () => {
  ports.onboardingPending.mockReturnValue(true);
  await previewMain(run("student"));
  expect(ports.runBrowserOnboarding).not.toHaveBeenCalled();
  expect(ports.runForeground).toHaveBeenCalled();
});
