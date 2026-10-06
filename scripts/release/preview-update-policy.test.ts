import { expect, it, vi } from "vitest";
import { managerPorts, state } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";
const ports = managerPorts();
const run = (...args: string[]) =>
  previewMain(["run", state.selected, "--root", "/private", "--", ...args]);

it("installs a recommended version without connecting to a school, or an explicit pilot version", async () => {
  const args = [
    "install",
    "student",
    "--root",
    "/private",
    "--repository",
    "school/marea",
    "--server",
    "https://school.test",
    "--cosign",
    "/cosign",
  ];
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.3");
  await previewMain(args);
  expect(ports.installRelease).toHaveBeenCalledWith(
    expect.objectContaining({ version: "0.1.0-preview.3" }),
    expect.any(Object),
  );
  expect(ports.requiredPreviewVersion).not.toHaveBeenCalled();
  ports.offeredVersion.mockResolvedValue(undefined);
  await expect(previewMain(args)).rejects.toThrow("No recommended preview");
  expect(ports.installRelease).toHaveBeenCalledTimes(1);
});

it("manual update uses available releases, accepts explicit student rollback, and never consults the school", async () => {
  ports.acceptUpdate.mockResolvedValue(true);
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.9");
  await run("update");
  expect(ports.offeredVersion).toHaveBeenCalledWith(
    expect.objectContaining({ component: "student" }),
    globalThis.fetch,
    "available",
  );
  expect(ports.acceptUpdate).toHaveBeenLastCalledWith("0.1.0-preview.9", false);
  ports.offeredVersion.mockClear();
  await run("update", "--version", "0.0.0-preview.1");
  expect(ports.installRelease).toHaveBeenLastCalledWith(
    expect.objectContaining({ version: "0.0.0-preview.1" }),
    expect.any(Object),
  );
  expect(ports.offeredVersion).not.toHaveBeenCalled();
  expect(ports.requiredPreviewVersion).not.toHaveBeenCalled();
  expect(ports.runForeground).not.toHaveBeenCalled();
  for (const args of [
    ["bad"],
    ["--version"],
    ["--version", "bad"],
    ["--version", "0.1.0-preview.2", "extra"],
  ])
    await expect(run("update", ...args)).rejects.toThrow();
});

it("reports unsuccessful manual discovery and rejects explicit server downgrade", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.offeredVersion.mockRejectedValue(new Error("offline"));
  await run("update");
  expect(process.exitCode).toBe(1);
  state.selected = "server";
  await expect(run("update", "--version", "0.0.0-preview.1")).rejects.toThrow("backup recovery");
  expect(ports.acceptUpdate).not.toHaveBeenCalled();
});

it("requires consent for a protocol repair and blocks connection after refusal or a failed verified download", async () => {
  ports.requiredPreviewVersion.mockResolvedValue("0.1.0-preview.2");
  ports.acceptUpdate.mockResolvedValue(false);
  await expect(run()).rejects.toThrow("Instala Marea 0.1.0-preview.2");
  expect(ports.acceptUpdate).toHaveBeenCalledWith("0.1.0-preview.2", true);
  expect(ports.offeredVersion).not.toHaveBeenCalled();
  ports.acceptUpdate.mockResolvedValue(true);
  ports.downloadPreview.mockRejectedValueOnce(new Error("invalid signature"));
  await expect(run()).rejects.toThrow("versión 0.1.0-preview.2 necesaria");
  expect(ports.runForeground).not.toHaveBeenCalled();
  await run();
  expect(ports.runForeground).toHaveBeenCalledWith(
    "/private/programs/student-0.1.0-preview.2/marea",
    [],
    expect.any(Object),
  );
});

it("allows an explicitly required older student but does not loop on an inconsistent same-version server", async () => {
  ports.requiredPreviewVersion.mockResolvedValue("0.0.0-preview.1");
  ports.acceptUpdate.mockResolvedValue(true);
  await run();
  expect(ports.installRelease).toHaveBeenCalledWith(
    expect.objectContaining({ version: "0.0.0-preview.1" }),
    expect.any(Object),
  );
  ports.requiredPreviewVersion.mockResolvedValue(state.version);
  await expect(run()).rejects.toThrow("misma versión");
  expect(ports.installRelease).toHaveBeenCalledTimes(1);
});

it("routes uninstall without activation, update discovery, or launching the application", async () => {
  await run("uninstall", "--yes");
  expect(ports.uninstallPreview).toHaveBeenCalledWith(
    "/private",
    expect.objectContaining({ component: "student" }),
    ["--yes"],
  );
  expect(ports.readActivation).not.toHaveBeenCalled();
  expect(ports.requiredPreviewVersion).not.toHaveBeenCalled();
  expect(ports.offeredVersion).not.toHaveBeenCalled();
  expect(ports.runForeground).not.toHaveBeenCalled();
});

it("accepts the status alias and rejects a misspelled explicit version flag", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await run("status");
  expect(output).toHaveBeenCalledWith(expect.stringContaining('"version":"0.1.0-preview.1"'));
  expect(ports.runForeground).not.toHaveBeenCalled();
  await expect(run("update", "--ver", "0.1.0-preview.2")).rejects.toThrow(
    "Use update [--version X.Y.Z-preview.N]",
  );
});
