import { beforeEach, afterEach, vi } from "vitest";
const ports = vi.hoisted(() => ({
  uninstallPreview: vi.fn(),
  preparePreviewRoot: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  spawnSync: vi.fn(),
  securePrivatePath: vi.fn(),
  installRelease: vi.fn(),
  privateDirectory: vi.fn(),
  readActivation: vi.fn(),
  verifySignature: vi.fn(),
  downloadPreview: vi.fn(),
  offeredVersion: vi.fn(),
  requiredPreviewVersion: vi.fn(),
  activatePreviewServer: vi.fn(),
  assertPreviewServerReady: vi.fn(),
  provisionServer: vi.fn(),
  scaffoldServer: vi.fn(),
  acceptUpdate: vi.fn(),
  question: vi.fn(),
  serverQuestions: vi.fn(),
  configurePosixPath: vi.fn(),
  runForeground: vi.fn(),
}));
vi.mock("./preview-uninstall.boundary.js", () => ports);
vi.mock("./preview-existing.boundary.js", () => ports);
vi.mock("node:fs", () => ports);
vi.mock("node:child_process", () => ports);
vi.mock("node:os", () => ({ homedir: () => "/home/test" }));
vi.mock("@marea/private-filesystem", () => ports);
vi.mock("./install.boundary.js", () => ports);
vi.mock("./preview-download.boundary.js", () => ports);
vi.mock("./preview-server-update.boundary.js", () => ports);
vi.mock("./preview-setup.boundary.js", () => ports);
vi.mock("./preview-terminal.boundary.js", () => ports);
vi.mock("./preview-path.boundary.js", () => ports);
vi.mock("./preview-process.boundary.js", () => ports);
export const state = {
  selected: "student",
  version: "0.1.0-preview.1",
  installation: "/private/installation" as string | undefined,
  missingInstallation: false,
};
export const answers = {
  center: "School",
  classroom: "Class",
  teacher: "Teacher",
  login: "teacher",
  port: 18787,
  origin: "https://school.test",
};
const platform = Object.getOwnPropertyDescriptor(process, "platform");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MAREA_SERVER_URL", "");
  vi.stubEnv("MAREA_STATE_HOME", "");
  state.selected = "student";
  state.version = "0.1.0-preview.1";
  state.missingInstallation = false;
  ports.readFileSync.mockImplementation((path: string) =>
    JSON.stringify(
      path.endsWith("manifest.json")
        ? {
            format: 1,
            version: state.version,
            component: state.selected,
            target: "darwin-arm64",
            bun: "1.4.2",
            opentui: "0.5.10",
            commit: "a".repeat(40),
            files: [{ path: "marea", executable: true, sha256: "b".repeat(64) }],
          }
        : {
            format: 1,
            repository: "school/marea",
            component: state.selected,
            channel: "preview",
            ...(state.selected === "server"
              ? state.missingInstallation
                ? {}
                : { installation: "/private/installation" }
              : { serverUrl: "https://school.test" }),
          },
    ),
  );
  ports.readActivation.mockImplementation(() => ({
    current: `${state.selected}-${state.version}`,
    previous: null,
  }));
  ports.mkdtempSync.mockReturnValue("/private/.download-stage");
  ports.spawnSync.mockReturnValue({ status: 0, stdout: "ok" });
  ports.runForeground.mockResolvedValue(0);
  ports.assertPreviewServerReady.mockReturnValue("release:preview");
  ports.question.mockResolvedValue("https://school.test");
  ports.serverQuestions.mockResolvedValue({ answers, password: "private-password" });
  ports.preparePreviewRoot.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (platform) Object.defineProperty(process, "platform", platform);
  process.exitCode = 0;
});

export function managerPorts() {
  return ports;
}
