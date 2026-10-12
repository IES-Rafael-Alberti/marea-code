import { expect, it, vi } from "vitest";
import { OperatorCliError } from "../../apps/teacher-server/src/platform/operator-cli/errors.js";
import { managerPorts, state } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";

const ports = managerPorts();
const update = () => previewMain(["update", state.selected, "--root", "/private"]);

it.each(["before download", "during activation"])(
  "explains a busy server %s and keeps the installed version available for retry",
  async (phase) => {
    state.selected = "server";
    ports.offeredVersion.mockResolvedValue("0.1.0-preview.31");
    ports.acceptUpdate.mockResolvedValue(true);
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const busy = new OperatorCliError("installation-busy");
    if (phase === "before download")
      ports.assertPreviewServerIdle.mockImplementationOnce(() => {
        throw busy;
      });
    else ports.installRelease.mockRejectedValueOnce(busy);

    await update();
    expect(ports.assertPreviewServerIdle).toHaveBeenCalledExactlyOnceWith("/private/installation");
    expect(ports.downloadPreview).toHaveBeenCalledTimes(phase === "before download" ? 0 : 1);
    expect(ports.installRelease).toHaveBeenCalledTimes(phase === "before download" ? 0 : 1);
    expect(ports.runForeground).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output.mock.calls.at(-1)).toEqual([
      "La instalación sigue bloqueada. Cierra el servidor si está en marcha y vuelve a ejecutar marea-teacher update para revisar el bloqueo. Se conserva la versión instalada.\n",
    ]);
    const version = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await previewMain(["run", "server", "--root", "/private", "--", "--version"]);
    expect(version).toHaveBeenCalledWith(`${state.version}\n`);
    ports.downloadPreview.mockClear();
    ports.installRelease.mockClear();
    await update();
    expect(ports.installRelease).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ version: "0.1.0-preview.31" }),
      expect.any(Object),
    );
    expect(ports.assertPreviewServerIdle.mock.invocationCallOrder.at(-1)).toBeLessThan(
      ports.downloadPreview.mock.invocationCallOrder[0] ?? 0,
    );
  },
);

it("waits for lock recovery consent before downloading and stops when recovery is refused", async () => {
  state.selected = "server";
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.31");
  ports.acceptUpdate.mockResolvedValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  for (const accepted of [false, true]) {
    ports.downloadPreview.mockClear();
    ports.installRelease.mockClear();
    ports.assertPreviewServerIdle.mockClear();
    const recovery = Promise.withResolvers<undefined>();
    ports.assertPreviewServerIdle.mockReturnValueOnce(recovery.promise);
    const updating = update();
    await vi.waitFor(() => {
      expect(ports.assertPreviewServerIdle).toHaveBeenCalledOnce();
    });
    expect(ports.downloadPreview).not.toHaveBeenCalled();
    expect(ports.installRelease).not.toHaveBeenCalled();
    if (accepted) recovery.resolve(undefined);
    else recovery.reject(new OperatorCliError("installation-busy"));
    await updating;
    expect(ports.downloadPreview).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(ports.installRelease).toHaveBeenCalledTimes(accepted ? 1 : 0);
  }
});

it("does not label other ownership errors as a running server", async () => {
  state.selected = "server";
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.31");
  ports.acceptUpdate.mockResolvedValue(true);
  ports.assertPreviewServerIdle.mockImplementation(() => {
    throw new OperatorCliError("installation-unavailable");
  });
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await update();
  expect(output).toHaveBeenCalledExactlyOnceWith(
    "No se ha podido actualizar; se conserva la instalación verificada.\n",
  );
  expect(ports.downloadPreview).not.toHaveBeenCalled();
});

it.each([
  { selected: "student", pending: false },
  { selected: "student", pending: true },
  { selected: "server", pending: true },
])(
  "does not require school data for $selected with setup pending=$pending",
  async ({ selected, pending }) => {
    state.selected = selected;
    ports.onboardingPending.mockReturnValue(pending);
    ports.offeredVersion.mockResolvedValue("0.1.0-preview.31");
    ports.acceptUpdate.mockResolvedValue(true);
    await update();
    expect(ports.assertPreviewServerIdle).not.toHaveBeenCalled();
    expect(ports.installRelease).toHaveBeenCalledOnce();
  },
);
