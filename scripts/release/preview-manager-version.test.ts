import { expect, it, vi } from "vitest";

import { managerPorts, state } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";

const ports = managerPorts();
const run = (selected = "student", extra: string[] = []) => [
  "run",
  selected,
  "--root",
  "/private",
  "--",
  ...extra,
];
const update = (selected: string) => ["update", selected, "--root", "/private"];

it.each(["student", "server"])(
  "prints the installed release for -v exactly like --version for the %s",
  async (selected) => {
    state.selected = selected;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await previewMain(run(selected, ["-v"]));
    await previewMain(run(selected, ["--version"]));
    expect(output.mock.calls).toEqual([["0.1.0-preview.1\n"], ["0.1.0-preview.1\n"]]);
    expect(ports.requiredPreviewVersion).not.toHaveBeenCalled();
    expect(ports.offeredVersion).not.toHaveBeenCalled();
    expect(ports.recoverInterruptedPreviewUpdate).not.toHaveBeenCalled();
    expect(ports.runForeground).not.toHaveBeenCalled();
  },
);

it.each([["feedback"], ["logout"], ["feedback", "--ack", "event:01"]])(
  "starts %s without checking for updates",
  async (...command) => {
    await previewMain(run("student", command));
    expect(ports.requiredPreviewVersion).not.toHaveBeenCalled();
    expect(ports.offeredVersion).not.toHaveBeenCalled();
    expect(ports.runForeground).toHaveBeenCalledWith(
      "/private/programs/student-0.1.0-preview.1/marea",
      command,
      expect.any(Object),
    );
  },
);

it.each(["student", "server"])(
  "says that the %s is already on the latest version after a manual update",
  async (selected) => {
    state.selected = selected;
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    ports.offeredVersion.mockResolvedValueOnce("0.1.0-preview.1");
    await previewMain(update(selected));
    ports.offeredVersion.mockResolvedValueOnce(undefined);
    await previewMain(update(selected));
    expect(output.mock.calls).toEqual([
      ["Marea ya está en la última versión (0.1.0-preview.1).\n"],
      ["Marea ya está en la última versión (0.1.0-preview.1).\n"],
    ]);
    expect(ports.offeredVersion).toHaveBeenCalledWith(
      expect.any(Object),
      globalThis.fetch,
      "available",
    );
    expect(process.exitCode).toBe(0);
  },
);

it("explains why a manual update could not check instead of claiming it is up to date", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://proxy.school:3128");
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.offeredVersion.mockRejectedValueOnce(
    Object.assign(new TypeError("Unable to connect."), { code: "ConnectionRefused" }),
  );
  await previewMain(update("student"));
  expect(output).not.toHaveBeenCalled();
  expect(errors.mock.calls).toEqual([
    [
      "No se ha podido consultar GitHub (raw.githubusercontent.com) para buscar actualizaciones: fallo del proxy configurado en HTTPS_PROXY (sin conexión). Se conserva la versión instalada.\n",
    ],
  ]);
  expect(process.exitCode).toBe(1);
});

it("does not claim the latest version for an explicitly selected installed release", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await previewMain(["update", "student", "--root", "/private", "--version", "0.1.0-preview.1"]);
  expect(output).not.toHaveBeenCalled();
  expect(ports.offeredVersion).not.toHaveBeenCalled();
});

it("still asks GitHub when the classroom server is unreachable at start", async () => {
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.requiredPreviewVersion.mockRejectedValueOnce(
    Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
  );
  ports.offeredVersion.mockResolvedValueOnce("0.1.0-preview.2");
  await previewMain(run());
  expect(errors.mock.calls).toEqual([
    [
      "No se ha podido consultar el servidor del aula (https://school.test) para buscar actualizaciones: tiempo agotado tras 2 s.\n",
    ],
  ]);
  expect(ports.acceptUpdate).toHaveBeenCalledWith("0.1.0-preview.2", false);
  expect(ports.runForeground).toHaveBeenCalledOnce();
});
