import { afterEach, expect, it, vi } from "vitest";
import { DownloadResponseError, retryReleaseDownload } from "./preview-retry.boundary.js";
import { InstallerUsageError } from "./installer-cli.boundary.js";
afterEach(() => {
  vi.useRealTimers();
});
it("returns successful downloads without waiting or reporting a retry", async () => {
  const report = vi.fn();
  const value = new Uint8Array([1, 2]);
  await expect(retryReleaseDownload("client", () => Promise.resolve(value), report)).resolves.toBe(
    value,
  );
  expect(report).not.toHaveBeenCalled();
});
it("retries transient network failures with exponential delays", async () => {
  vi.useFakeTimers();
  const download = vi
    .fn()
    .mockRejectedValueOnce(new Error("socket reset"))
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValue("complete");
  const report = vi.fn();
  const result = retryReleaseDownload("bin/marea", download, report);
  await vi.advanceTimersByTimeAsync(999);
  expect(download).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(download).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(download).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("complete");
  expect(report.mock.calls).toEqual([
    ["Descarga interrumpida: bin/marea. Reintentando (2/4) en 1 s..."],
    ["Descarga interrumpida: bin/marea. Reintentando (3/4) en 2 s..."],
  ]);
});
it("honors a longer server retry delay", async () => {
  vi.useFakeTimers();
  const download = vi
    .fn()
    .mockRejectedValueOnce(new DownloadResponseError("HTTP 429", true, 5000))
    .mockResolvedValue("ok");
  const result = retryReleaseDownload("manifest", download, vi.fn());
  await vi.advanceTimersByTimeAsync(4999);
  expect(download).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("ok");
});
it("stops after four attempts and reports the file without leaking transport details", async () => {
  vi.useFakeTimers();
  const download = vi.fn().mockRejectedValue(new Error("private proxy credential"));
  const result = retryReleaseDownload("assets/logo.svg", download, vi.fn()).catch(
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  const error = await result;
  expect(download).toHaveBeenCalledTimes(4);
  expect(error).toBeInstanceOf(InstallerUsageError);
  expect(error).toEqual(
    new InstallerUsageError(
      "No se pudo descargar assets/logo.svg (fallo de conexión). Vuelve a ejecutar el comando de instalación. No se ha activado una versión incompleta.",
    ),
  );
});
it("does not retry permanent failures", async () => {
  const download = vi.fn().mockRejectedValue(new DownloadResponseError("HTTP 404", false));
  const report = vi.fn();
  await expect(retryReleaseDownload("missing", download, report)).rejects.toThrow(
    "No se pudo descargar missing (HTTP 404).",
  );
  expect(download).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});
