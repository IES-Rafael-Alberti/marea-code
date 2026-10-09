import { expect, it, vi } from "vitest";
import { managerPorts, state } from "./preview-manager.fixture.js";
import {
  parsePreviewArguments,
  previewMain,
  runPrivateCommand,
} from "./preview-manager.boundary.js";
import type { InstallPorts } from "./install.boundary.js";
import type { DownloadPorts } from "./preview-download.boundary.js";

const ports = managerPorts();
const install = (selected = "student", extra: string[] = []) => [
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
  ...extra,
];
const run = (selected = "student", extra: string[] = []) => [
  "run",
  selected,
  "--root",
  "/private",
  "--",
  ...extra,
];

it("strictly parses flags and protects private subprocess input from diagnostics", () => {
  expect(
    parsePreviewArguments(["run", "student", "--root", "/private", "--", "--lang", "eu"]),
  ).toEqual({
    action: "run",
    selected: "student",
    flags: new Map([["--root", "/private"]]),
    forwarded: ["--lang", "eu"],
  });
  for (const argv of [
    [],
    ["bad", "student"],
    ["run", "other"],
    ["run", "student", "--bad", "x"],
    ["run", "student", "--root"],
    ["run", "student", "--root", "a", "--root", "b"],
  ])
    expect(() => parsePreviewArguments(argv)).toThrow();
  expect(
    runPrivateCommand(
      "binary",
      ["--installation", "/private", "credential", "provision"],
      "private-secret",
    ),
  ).toBe("ok");
  expect(ports.spawnSync).toHaveBeenCalledWith(
    "binary",
    ["--installation", "/private", "credential", "provision"],
    { input: "private-secret", encoding: "utf8", timeout: 120000 },
  );
  ports.spawnSync.mockReturnValue({ status: null, stderr: "private-secret" });
  expect(() =>
    runPrivateCommand("binary", ["--installation", "/private", "credential", "provision"]),
  ).toThrow(
    "Setup command failed: credential provision (exit null). Private details were not printed.",
  );
  expect(() => runPrivateCommand("binary", [])).not.toThrow("private-secret");
});

it("installs a student, verifies through the supplied bootstrap tool and writes launchers only after activation", async () => {
  ports.configurePosixPath.mockReturnValue(true);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await previewMain(install());
  expect(ports.question).toHaveBeenCalledWith("Dirección del servidor del centro");
  expect(ports.downloadPreview).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "https://school.test", component: "student" }),
    "0.1.0-preview.1",
    `${process.platform}-${process.arch}`,
    "/private/.download-stage",
    expect.any(Object),
  );
  const downloadPorts = ports.downloadPreview.mock.calls[0]?.[4] as DownloadPorts;
  downloadPorts.verify("manifest", "bundle", "identity");
  expect(ports.verifySignature).toHaveBeenCalledWith(
    "manifest",
    "bundle",
    "identity",
    "/verified/cosign",
  );
  expect(ports.installRelease).toHaveBeenCalledWith(
    expect.objectContaining({
      root: "/staging/programs",
      ref: "refs/tags/v0.1.0-preview.1",
      reuseVerifiedStudent: true,
    }),
    expect.any(Object),
  );
  const installPorts = ports.installRelease.mock.calls[0]?.[1] as InstallPorts;
  expect(() => installPorts.withOfflineBackup(() => Promise.resolve())).toThrow(
    "Missing server installation",
  );
  expect(ports.writeFileSync).toHaveBeenCalledWith(
    "/staging/bin/marea",
    expect.stringContaining("preview run student"),
    { flag: "wx", mode: 0o700 },
  );
  expect(ports.writeFileSync).toHaveBeenCalledWith(
    "/staging/preview.json",
    JSON.stringify({
      format: 1,
      repository: "school/marea",
      component: "student",
      channel: "preview",
      serverUrl: "https://school.test",
    }),
    { flag: "wx", mode: 0o600 },
  );
  expect(ports.provisionServer).not.toHaveBeenCalled();
  expect(ports.markOnboardingPending).not.toHaveBeenCalled();
  expect(ports.rmSync).toHaveBeenCalledWith("/private/.download-stage", {
    recursive: true,
    force: true,
  });
  expect(output.mock.calls).toMatchSnapshot("student installation instructions");
  expect(ports.installPreviewAtomically).toHaveBeenCalledWith("/private", expect.any(Function));
  expect(ports.mkdirSync.mock.calls).toEqual([["/staging/bin", { mode: 0o700 }]]);
  expect(ports.writeFileSync).toHaveBeenCalledWith(
    "/staging/bin/marea",
    expect.stringContaining("root='/private'"),
    expect.any(Object),
  );
});

it("does not overwrite existing state or mark a failed setup as complete", async () => {
  ports.preparePreviewRoot.mockRejectedValueOnce(new Error("already exists"));
  await expect(previewMain(install())).rejects.toThrow("already exists");
  await expect(previewMain(install().slice(0, -2))).rejects.toThrow("verified bootstrap");
  ports.downloadPreview.mockRejectedValueOnce(new Error("signature rejected"));
  await expect(
    previewMain(install("student", ["--server", "https://school.test"])),
  ).rejects.toThrow("signature rejected");
  expect(ports.rmSync).toHaveBeenCalled();
  expect(ports.writeFileSync).not.toHaveBeenCalled();
});

it("defers school provisioning to the first browser launch and binds the offline update callback to its data directory", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.stubEnv("SHELL", undefined);
  await previewMain(install("server"));
  expect(ports.markOnboardingPending).toHaveBeenCalledExactlyOnceWith("/staging");
  expect(ports.scaffoldServer).not.toHaveBeenCalled();
  expect(ports.provisionServer).not.toHaveBeenCalled();
  const installPorts = ports.installRelease.mock.calls[0]?.[1] as InstallPorts;
  const activate = () => Promise.resolve();
  await installPorts.withOfflineBackup(activate);
  expect(ports.activatePreviewServer).toHaveBeenCalledWith(
    "/private/installation",
    "/staging/programs/server-0.1.0-preview.1",
    "0.1.0-preview.1",
    activate,
  );
  expect(ports.writeFileSync).toHaveBeenCalledWith(
    "/staging/bin/marea-teacher",
    expect.any(String),
    expect.any(Object),
  );
  expect(ports.configurePosixPath).toHaveBeenCalledWith("/home/test", "/bin/sh", "/private/bin");
  expect(output.mock.calls).toMatchSnapshot("server installation instructions");
});

it("installs per-user Windows launchers and PATH without a shell profile", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  Object.defineProperty(process, "platform", { value: "win32" });
  await previewMain(install("student", ["--server", "https://school.test"]));
  expect(ports.writeFileSync).toHaveBeenCalledWith(
    "/staging/bin/marea.ps1",
    expect.stringContaining("marea-install.exe"),
    expect.any(Object),
  );
  expect(ports.writeFileSync).toHaveBeenCalledWith(
    "/staging/bin/marea.cmd",
    expect.stringContaining("-ExecutionPolicy Bypass"),
    expect.any(Object),
  );
  expect(ports.spawnSync).toHaveBeenCalledWith(
    "powershell.exe",
    expect.arrayContaining([
      "-NoProfile",
      "-Command",
      expect.stringContaining("SetEnvironmentVariable"),
    ]),
    expect.any(Object),
  );
  expect(ports.configurePosixPath).not.toHaveBeenCalled();
  expect(ports.writeFileSync.mock.calls).toMatchSnapshot("Windows launcher files");
  expect(ports.spawnSync.mock.calls).toMatchSnapshot("Windows per-user PATH command");
});

it("returns help, actual version and status without network discovery", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await previewMain(run("student", ["--help"]));
  await previewMain(run("student", ["-h"]));
  await previewMain(run("student", ["--version"]));
  expect(output).toHaveBeenCalledWith("0.1.0-preview.1\n");
  await previewMain(run("student", ["--status"]));
  expect(output).toHaveBeenLastCalledWith(expect.stringContaining('"channel":"preview"'));
  expect(output.mock.calls).toMatchSnapshot("managed help and status");
  expect(ports.offeredVersion).not.toHaveBeenCalled();
  await expect(previewMain(run("server"))).rejects.toThrow("Component selection mismatch");
  ports.readActivation.mockReturnValueOnce(null);
  await expect(previewMain(run())).rejects.toThrow("No active preview");
});

it("continues offline, honors explicit environment and forwards student arguments", async () => {
  vi.stubEnv("MAREA_SERVER_URL", "https://another.test");
  vi.stubEnv("MAREA_STATE_HOME", "/project/state");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.offeredVersion.mockRejectedValueOnce(new Error("offline"));
  ports.runForeground.mockResolvedValueOnce(7);
  await previewMain(run("student", ["--lang", "eu"]));
  expect(ports.offeredVersion).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "https://another.test" }),
    globalThis.fetch,
    "recommended",
  );
  expect(ports.runForeground).toHaveBeenCalledWith(
    "/private/programs/student-0.1.0-preview.1/marea",
    ["--lang", "eu"],
    expect.objectContaining({
      MAREA_SERVER_URL: "https://another.test",
      MAREA_STATE_HOME: "/project/state",
    }),
  );
  expect(process.exitCode).toBe(7);
});

it("asks before installing a discovered version and never automatically downgrades students", async () => {
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.2");
  ports.acceptUpdate.mockResolvedValue(false);
  await previewMain(run());
  expect(ports.installRelease).not.toHaveBeenCalled();
  ports.acceptUpdate.mockResolvedValue(true);
  await previewMain(run("student", ["--update"]));
  expect(ports.installRelease).toHaveBeenCalledWith(
    expect.objectContaining({ version: "0.1.0-preview.2" }),
    expect.any(Object),
  );
  expect(ports.runForeground).toHaveBeenCalledTimes(1);
  ports.offeredVersion.mockResolvedValue("0.0.0-preview.1");
  await previewMain(run());
  expect(ports.installRelease).toHaveBeenCalledTimes(1);
});

it("never downgrades a server, checks recovery first and launches its own installation", async () => {
  state.selected = "server";
  ports.offeredVersion.mockResolvedValue("0.0.0-preview.1");
  await previewMain(run("server"));
  expect(ports.acceptUpdate).not.toHaveBeenCalled();
  expect(ports.runForeground).toHaveBeenCalledWith(
    expect.stringContaining("server-0.1.0-preview.1/marea-teacher"),
    ["--installation", "/private/installation", "--release", "release:preview"],
    expect.any(Object),
  );
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.2");
  ports.acceptUpdate.mockResolvedValue(true);
  await previewMain(run("server"));
  expect(ports.installRelease).toHaveBeenCalledWith(
    expect.objectContaining({ version: "0.1.0-preview.2", reuseVerifiedStudent: false }),
    expect.any(Object),
  );
  ports.assertPreviewServerReady.mockImplementationOnce(() => {
    throw new Error("recover first");
  });
  await expect(previewMain(run("server"))).rejects.toThrow("recover first");
  state.missingInstallation = true;
  ports.offeredVersion.mockResolvedValue(undefined);
  await expect(previewMain(run("server"))).rejects.toThrow("Missing server installation");
});

it("uses the managed home by default", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await previewMain(["status", "student"]);
  expect(ports.privateDirectory).toHaveBeenCalledWith("/home/test/.marea-preview/student");
  expect(output).toHaveBeenCalled();
});

it("keeps a verified installation usable after a refused download and propagates recovery requirements", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.2");
  ports.acceptUpdate.mockResolvedValue(true);
  ports.downloadPreview.mockRejectedValue(new Error("invalid signature"));
  await previewMain(run("student", ["--update"]));
  expect(process.exitCode).toBe(1);
  expect(ports.runForeground).not.toHaveBeenCalled();
  expect(ports.installRelease).not.toHaveBeenCalled();
  state.selected = "server";
  await previewMain(run("server"));
  expect(ports.runForeground).toHaveBeenCalledWith(
    expect.stringContaining("server-0.1.0-preview.1/marea-teacher"),
    expect.any(Array),
    expect.any(Object),
  );
  ports.assertPreviewServerReady
    .mockReset()
    .mockReturnValueOnce("release:preview")
    .mockImplementationOnce(() => {
      throw new Error("recovery required");
    });
  await expect(previewMain(run("server"))).rejects.toThrow("recovery required");
});

it("uses saved server settings and private state when environment variables are absent, including Windows executables", async () => {
  vi.stubEnv("MAREA_SERVER_URL", undefined);
  vi.stubEnv("MAREA_STATE_HOME", undefined);
  Object.defineProperty(process, "platform", { value: "win32" });
  await previewMain(run());
  expect(ports.runForeground).toHaveBeenCalledWith(
    expect.stringContaining("/marea.exe"),
    [],
    expect.objectContaining({
      MAREA_SERVER_URL: "https://school.test",
      MAREA_STATE_HOME: "/private/student-state",
    }),
  );
});

it("does not query a student's recovery journal, reinstall equal versions, or lose whitespace-normalized overrides", async () => {
  vi.stubEnv("MAREA_SERVER_URL", " https://another.test ");
  vi.stubEnv("MAREA_STATE_HOME", " /project/state ");
  ports.offeredVersion.mockResolvedValue(state.version);
  await previewMain(run());
  expect(ports.assertPreviewServerReady).not.toHaveBeenCalled();
  expect(ports.acceptUpdate).not.toHaveBeenCalled();
  expect(ports.runForeground).toHaveBeenCalledWith(
    expect.any(String),
    [],
    expect.objectContaining({
      MAREA_SERVER_URL: "https://another.test",
      MAREA_STATE_HOME: "/project/state",
    }),
  );
  state.selected = "server";
  await previewMain(run("server"));
  expect(ports.offeredVersion).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ serverUrl: expect.anything() as string }),
    globalThis.fetch,
    "recommended",
  );
  expect(ports.acceptUpdate).not.toHaveBeenCalled();
});

it("keeps offline diagnostics useful and checks server recovery after a failed update", async () => {
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  ports.offeredVersion.mockRejectedValueOnce(new Error("offline"));
  await previewMain(run());
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.2");
  ports.acceptUpdate.mockResolvedValue(true);
  ports.downloadPreview.mockRejectedValue(new Error("bad signature"));
  await previewMain(run());
  expect(ports.assertPreviewServerReady).not.toHaveBeenCalled();
  expect(output.mock.calls).toMatchSnapshot("offline and failed update diagnostics");
  state.selected = "server";
  ports.assertPreviewServerReady.mockClear();
  await previewMain(run("server"));
  expect(ports.assertPreviewServerReady).toHaveBeenCalledTimes(3);
});

it("uses native Windows binaries for accepted updates", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  ports.offeredVersion.mockResolvedValue("0.1.0-preview.2");
  ports.acceptUpdate.mockResolvedValue(true);
  await previewMain(run());
  const downloadPorts = ports.downloadPreview.mock.calls[0]?.[4] as DownloadPorts;
  downloadPorts.verify("manifest", "bundle", "identity");
  expect(ports.verifySignature).toHaveBeenCalledWith(
    "manifest",
    "bundle",
    "identity",
    "/private/programs/student-0.1.0-preview.1/cosign.exe",
  );
  expect(ports.runForeground).toHaveBeenCalledWith(
    "/private/programs/student-0.1.0-preview.2/marea.exe",
    [],
    expect.any(Object),
  );
});

it("rejects incomplete commands and preserves native file decoding and private setup flags", async () => {
  expect(() => parsePreviewArguments([])).toThrow(
    "Use preview install/run/update/status student/server",
  );
  expect(() => parsePreviewArguments(["bad", "student"])).toThrow(
    "Use preview install/run/update/status student/server",
  );
  expect(() => parsePreviewArguments(["run", "student", "--root", ""])).toThrow(
    "Invalid preview arguments",
  );
  expect(() => parsePreviewArguments(["run", "student", "--bad", "a"])).toThrow(
    "Invalid preview arguments",
  );
  ports.preparePreviewRoot.mockResolvedValueOnce(false);
  await previewMain(install());
  expect(ports.preparePreviewRoot).toHaveBeenCalledWith("/private", "student");
  expect(ports.downloadPreview).not.toHaveBeenCalled();
  await previewMain(run("student", ["--version"]));
  expect(ports.readFileSync.mock.calls).toEqual([
    ["/private/preview.json", "utf8"],
    ["/private/programs/student-0.1.0-preview.1/manifest.json", "utf8"],
  ]);
  ports.readActivation.mockReturnValueOnce(null);
  await expect(previewMain(run())).rejects.toThrow("No active preview installation");
});

it("supports direct update commands and keeps explicit school origins without prompting", async () => {
  expect(parsePreviewArguments(["update", "student"]).action).toBe("update");
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await previewMain(install("student", ["--server", "https://different-school.test"]));
  expect(ports.question).not.toHaveBeenCalled();
  expect(ports.downloadPreview).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "https://different-school.test" }),
    state.version,
    expect.any(String),
    expect.any(String),
    expect.any(Object),
  );
  expect(ports.mkdtempSync).toHaveBeenCalledWith("/staging/.download-");
  await previewMain(run("student", ["--version"]));
  expect(ports.readActivation).toHaveBeenCalledWith("/private/programs");
  expect(output).toHaveBeenCalled();
});

it("uses the explicit HTTP server for compatibility checks and launch without saving it", async () => {
  vi.stubEnv("MAREA_SERVER_URL", "https://environment.test");
  await previewMain(run("student", ["--server", "http://192.168.1.20:18787", "--no-mouse"]));
  expect(ports.requiredPreviewVersion.mock.calls[0]?.[0]).toMatchObject({
    serverUrl: "http://192.168.1.20:18787",
  });
  expect(ports.runForeground.mock.calls[0]?.[1]).toEqual([
    "--server",
    "http://192.168.1.20:18787",
    "--no-mouse",
  ]);
  expect((ports.runForeground.mock.calls[0]?.[2] as NodeJS.ProcessEnv).MAREA_SERVER_URL).toBe(
    "http://192.168.1.20:18787",
  );
  expect(ports.writeFileSync).not.toHaveBeenCalled();
});

it("rejects ambiguous server flags before discovery or launch", async () => {
  await expect(previewMain(run("student", ["--server"]))).rejects.toThrow("Use --server");
  expect(ports.requiredPreviewVersion).not.toHaveBeenCalled();
  expect(ports.runForeground).not.toHaveBeenCalled();
});

it("passes the HTTP startup flag through the managed teacher launcher", async () => {
  state.selected = "server";
  await previewMain(run("server", ["--allow-http"]));
  expect(ports.runForeground.mock.calls[0]?.[1]).toEqual([
    "--installation",
    "/private/installation",
    "--release",
    "release:preview",
    "--allow-http",
  ]);
});

it("lets an unconfigured student reach its missing-server diagnostic", async () => {
  const read = ports.readFileSync.getMockImplementation();
  ports.readFileSync.mockImplementation((path: string) => {
    const value = String(read?.(path));
    if (!path.endsWith("preview.json")) return value;
    const settings = JSON.parse(value) as Record<string, unknown>;
    delete settings.serverUrl;
    return JSON.stringify(settings);
  });
  await previewMain(run());
  expect(
    (ports.runForeground.mock.calls[0]?.[2] as NodeJS.ProcessEnv).MAREA_SERVER_URL,
  ).toBeUndefined();
});

it("uses the saved server when the environment contains only whitespace", async () => {
  vi.stubEnv("MAREA_SERVER_URL", "   ");
  await previewMain(run());
  expect((ports.runForeground.mock.calls[0]?.[2] as NodeJS.ProcessEnv).MAREA_SERVER_URL).toBe(
    "https://school.test",
  );
});
