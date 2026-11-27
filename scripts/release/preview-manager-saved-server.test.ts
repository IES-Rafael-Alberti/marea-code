import { expect, it, vi } from "vitest";

import { managerPorts } from "./preview-manager.fixture.js";
import { previewMain } from "./preview-manager.boundary.js";

const ports = managerPorts();
const run = (extra: string[] = []) => ["run", "student", "--root", "/private", "--", ...extra];

/** The default fixture files plus a server.json whose content the test chooses. */
function withSavedServer(content: string | Error) {
  const fixture = ports.readFileSync.getMockImplementation() as (path: string) => string;
  ports.readFileSync.mockImplementation((path: string) => {
    if (!path.endsWith("server.json")) return fixture(path);
    if (content instanceof Error) throw content;
    return content;
  });
}

const saved = (server: string) => JSON.stringify({ version: 1, server });
const launchedServer = () =>
  (ports.runForeground.mock.calls[0]?.[2] as NodeJS.ProcessEnv).MAREA_SERVER_URL;

it("checks for updates and launches against the saved server before the installer's", async () => {
  withSavedServer(saved("http://192.168.1.20:18787"));
  await previewMain(run(["--no-mouse"]));
  expect(ports.readFileSync).toHaveBeenCalledWith("/private/student-state/server.json", "utf8");
  expect(ports.requiredPreviewVersion.mock.calls[0]?.[0]).toMatchObject({
    serverUrl: "http://192.168.1.20:18787",
  });
  expect(ports.offeredVersion.mock.calls[0]?.[0]).toMatchObject({
    serverUrl: "http://192.168.1.20:18787",
  });
  expect(launchedServer()).toBe("http://192.168.1.20:18787");
});

it("prefers the saved server over MAREA_SERVER_URL and reads it from MAREA_STATE_HOME", async () => {
  vi.stubEnv("MAREA_SERVER_URL", "https://environment.test");
  vi.stubEnv("MAREA_STATE_HOME", "/custom/state");
  withSavedServer(saved("https://saved.test"));
  await previewMain(run());
  expect(ports.readFileSync).toHaveBeenCalledWith("/custom/state/server.json", "utf8");
  expect(launchedServer()).toBe("https://saved.test");
});

it("lets an explicit --server override the saved server", async () => {
  withSavedServer(saved("https://saved.test"));
  await previewMain(run(["--server", "https://flag.test"]));
  expect(ports.offeredVersion.mock.calls[0]?.[0]).toMatchObject({ serverUrl: "https://flag.test" });
  expect(launchedServer()).toBe("https://flag.test");
});

it.each([
  ["a missing file", new Error("ENOENT")],
  ["a corrupt file", "{ corrupt"],
  ["an address the launcher cannot use", saved("https://saved.test/some/path")],
])("falls back to the installed server with %s", async (_name, content) => {
  withSavedServer(content);
  await previewMain(run());
  expect(launchedServer()).toBe("https://school.test");
});
