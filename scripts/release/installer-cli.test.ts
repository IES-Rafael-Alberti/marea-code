import { afterEach, expect, it, vi } from "vitest";
import {
  OperatorCliError,
  OperatorCliInterrupted,
} from "../../apps/teacher-server/src/platform/operator-cli/errors.js";
import { installerExitCode, InstallerUsageError } from "./installer-cli.boundary.js";

it("prints an actionable existing-installation diagnostic without a stack", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(
    await installerExitCode(vi.fn().mockRejectedValue(new InstallerUsageError("Use update."))),
  ).toBe(1);
  expect(output.mock.calls).toEqual([["Use update.\n"]]);
});

afterEach(() => vi.restoreAllMocks());

it("leaves successful command diagnostics and status intact", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const operation = vi.fn().mockResolvedValue(undefined);
  expect(await installerExitCode(operation)).toBe(0);
  expect(operation).toHaveBeenCalledOnce();
  expect(output).not.toHaveBeenCalled();
});

it.each([130, 143] as const)("cancels cleanly with signal status %s", async (code) => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await installerExitCode(vi.fn().mockRejectedValue(new OperatorCliInterrupted(code)))).toBe(
    code,
  );
  expect(output.mock.calls).toEqual([["Operación cancelada.\n"]]);
});

it("prints a concise terminal failure without an exception or a stack", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(
    await installerExitCode(vi.fn().mockRejectedValue(new OperatorCliError("invalid-input"))),
  ).toBe(1);
  expect(output.mock.calls).toEqual([["No se ha podido completar la lectura de la entrada.\n"]]);
});

it("explains an installation lock without misreporting a terminal failure", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(
    await installerExitCode(vi.fn().mockRejectedValue(new OperatorCliError("installation-busy"))),
  ).toBe(1);
  expect(output.mock.calls).toEqual([
    [
      "La instalación está en uso o conserva un bloqueo. Cierra el servidor antes de continuar; los datos no se han borrado.\n",
    ],
  ]);
});

it.each([new Error("unrelated failure"), "non-Error failure"])(
  "preserves unrelated installer failures: %s",
  async (error) => {
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(installerExitCode(vi.fn().mockRejectedValue(error))).rejects.toBe(error);
    expect(output).not.toHaveBeenCalled();
  },
);
