import { expect, it, vi } from "vitest";
import { managerPorts } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";
import type { DownloadPorts } from "./preview-download.boundary.js";

const ports = managerPorts();
const install = (component = "student") => [
  "install",
  component,
  "--root",
  "/private",
  "--repository",
  "school/marea",
  "--version",
  "0.1.0-preview.1",
  "--cosign",
  "/verified/cosign",
];

it("finishes the terminal progress line before a failed download is reported", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.downloadPreview.mockImplementationOnce(
    (_settings, _version, _platform, _root, download: DownloadPorts) => {
      download.progress?.update("Downloading bytes");
      throw new Error("download failed");
    },
  );
  try {
    await expect(previewMain(install())).rejects.toThrow("download failed");
    expect(output.mock.calls).toEqual([["\r\u001b[2KDownloading bytes"], ["\n"]]);
  } finally {
    if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  }
});

it.each(["student", "server"])("reports installation stages for %s", async (component) => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await previewMain(install(component));
  const download = ports.downloadPreview.mock.calls[0]?.[4] as DownloadPorts;
  expect(download.progress).toBeDefined();
  expect(output).toHaveBeenCalledWith("Instalando los archivos verificados...\n");
  if (component === "server")
    expect(output).toHaveBeenCalledWith(
      "Creando el centro, la clase y la cuenta del profesor...\n",
    );
});
