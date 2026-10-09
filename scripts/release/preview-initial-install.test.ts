import { expect, it, vi } from "vitest";
import { managerPorts } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";

const ports = managerPorts();
const install = () =>
  previewMain([
    "install",
    "server",
    "--root",
    "/private",
    "--repository",
    "school/marea",
    "--version",
    "0.1.0-preview.25",
    "--cosign",
    "/cosign",
  ]);

it("finishes settings and launchers before promoting, and updates PATH only afterwards", async () => {
  let promoted = false;
  ports.installPreviewAtomically.mockImplementation(
    async (_root: string, prepare: (stage: string) => Promise<void>) => {
      await prepare("/staging");
      expect(ports.writeFileSync).toHaveBeenCalledWith(
        "/staging/preview.json",
        expect.stringContaining('"installation":"/private/installation"'),
        { flag: "wx", mode: 0o600 },
      );
      expect(ports.writeFileSync).toHaveBeenCalledWith(
        "/staging/bin/marea-teacher",
        expect.stringContaining("root='/private'"),
        { flag: "wx", mode: 0o700 },
      );
      expect(ports.markOnboardingPending).toHaveBeenCalledWith("/staging");
      expect(ports.configurePosixPath).not.toHaveBeenCalled();
      promoted = true;
    },
  );
  ports.configurePosixPath.mockImplementation(() => {
    expect(promoted).toBe(true);
    return true;
  });
  await install();
  expect(ports.configurePosixPath).toHaveBeenCalledOnce();
});

it("does not touch PATH or report installation success if a launcher cannot be written", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  ports.writeFileSync.mockImplementation((path: string) => {
    if (path.includes("/bin/")) throw new Error("disk full");
  });
  await expect(install()).rejects.toThrow("disk full");
  expect(ports.configurePosixPath).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalledWith(expect.stringContaining("Instalado:"));
});

it.each(["posix", "windows"])(
  "keeps a complete usable installation and explains failed PATH integration: %s",
  async (platform) => {
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    if (platform === "windows") {
      Object.defineProperty(process, "platform", { value: "win32" });
      ports.spawnSync.mockReturnValue({ status: 1 });
    } else
      ports.configurePosixPath.mockImplementation(() => {
        throw new Error("profile is read only");
      });
    await install();
    expect(output).toHaveBeenLastCalledWith(
      "Marea está instalado, pero no se ha podido añadir el comando al PATH. Puedes ejecutarlo desde /private/bin o añadir esa carpeta al PATH manualmente.\n",
    );
    expect(ports.installPreviewAtomically).toHaveBeenCalledOnce();
  },
);
