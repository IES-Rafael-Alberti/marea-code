import { expect, it, vi } from "vitest";
import { managerPorts, state } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";
import { UpdateRolledBackError } from "./preview-update-rolled-back.js";

const ports = managerPorts();
const update = () => previewMain(["update", "server", "--root", "/private"]);

function offerServerUpdate(): void {
  state.selected = "server";
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.31");
  ports.acceptUpdate.mockResolvedValue(true);
}

it("tells the teacher that the update was undone, why it failed, and that a retry is possible", async () => {
  offerServerUpdate();
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.installRelease.mockRejectedValueOnce(
    new UpdateRolledBackError("EPERM: rename active.json"),
  );

  await update();

  expect(output.mock.calls.at(-1)).toEqual([
    "La actualización ha fallado y se ha vuelto a la versión anterior, que sigue funcionando. Los datos no se han modificado. Causa: EPERM: rename active.json. Puedes reintentar con marea-teacher update.\n",
  ]);
  expect(process.exitCode).toBe(1);
  expect(ports.assertPreviewServerReady).toHaveBeenCalledTimes(2);
});

it("shows the cause of any other failed update instead of hiding it", async () => {
  offerServerUpdate();
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.installRelease.mockRejectedValueOnce(new Error("bad signature"));
  await update();
  expect(output.mock.calls.at(-1)).toEqual([
    "No se ha podido actualizar; se conserva la instalación verificada. Causa: bad signature\n",
  ]);

  output.mockClear();
  ports.installRelease.mockRejectedValueOnce("plain text");
  await update();
  expect(output.mock.calls.at(-1)).toEqual([
    "No se ha podido actualizar; se conserva la instalación verificada. Causa: plain text\n",
  ]);
});

it("keeps the original failure visible when it leaves the installation needing recovery", async () => {
  offerServerUpdate();
  ports.installRelease.mockRejectedValueOnce(new Error("rename failed"));
  ports.assertPreviewServerReady.mockReturnValueOnce("release:preview").mockImplementation(() => {
    throw new Error("An interrupted update needs recovery.");
  });

  await expect(update()).rejects.toMatchObject({
    message: "An interrupted update needs recovery. Cause of the failed update: rename failed",
    cause: { message: "An interrupted update needs recovery." },
  });

  ports.assertPreviewServerReady.mockReturnValueOnce("release:preview").mockImplementation(() => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "not an error";
  });
  ports.installRelease.mockRejectedValueOnce("disk gone");
  await expect(update()).rejects.toThrow("not an error Cause of the failed update: disk gone");
});

it.each([
  [true, true],
  [false, false],
  [undefined, false],
])(
  "recovers an interrupted update before reading the active release (%s)",
  async (recovered, said) => {
    state.selected = "server";
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    ports.recoverInterruptedPreviewUpdate.mockReturnValue(recovered);

    await previewMain(["run", "server", "--root", "/private"]);

    expect(ports.recoverInterruptedPreviewUpdate).toHaveBeenCalledExactlyOnceWith(
      "/private/installation",
    );
    expect(ports.recoverInterruptedPreviewUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      ports.readActivation.mock.invocationCallOrder[0] ?? 0,
    );
    const said_ = output.mock.calls.some(([text]) => String(text).includes("se interrumpió"));
    expect(said_).toBe(said);
  },
);

it.each([
  ["a student launch", "student", ["run", "student"], false],
  ["a version query", "server", ["run", "server", "--", "--version"], false],
  ["a status query", "server", ["status", "server"], false],
  ["a pending first-time setup", "server", ["run", "server"], true],
])("does not look for an interrupted update on %s", async (_name, selected, argv, pending) => {
  state.selected = selected;
  ports.onboardingPending.mockReturnValue(pending);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);

  await previewMain([...argv, "--root", "/private"]);

  expect(ports.recoverInterruptedPreviewUpdate).not.toHaveBeenCalled();
});
