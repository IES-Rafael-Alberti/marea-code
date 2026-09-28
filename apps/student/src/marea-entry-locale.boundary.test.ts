import { afterEach, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { executeMareaCommand } from "./marea-command.boundary.js";
import { createStudentLanguagePreferenceStore } from "./interface-locale.boundary.js";

vi.mock("./marea-command.boundary.js", () => ({
  executeMareaCommand: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("./interface-locale.boundary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interface-locale.boundary.js")>()),
  createStudentLanguagePreferenceStore: vi.fn(),
}));

const originalArguments = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each(["command-line", "environment", "saved"] as const)(
  "keeps automatic detection independent of the %s preference",
  async (source) => {
    vi.resetModules();
    process.argv = ["bun", "marea", ...(source === "command-line" ? ["--lang", "en"] : [])];
    vi.stubEnv("MAREA_LANG", source === "environment" ? "en" : undefined);
    vi.stubEnv("LC_ALL", "");
    vi.stubEnv("LC_MESSAGES", "es_ES.UTF-8");
    vi.stubEnv("LANG", "eu_ES.UTF-8");
    const store = {
      load: vi.fn(() => Promise.resolve(source === "saved" ? ("en" as const) : null)),
      save: vi.fn(),
    };
    vi.mocked(createStudentLanguagePreferenceStore).mockReturnValue(store);

    await import("./marea-entry.boundary.js");

    expect(executeMareaCommand).toHaveBeenCalledOnce();
    const options = vi.mocked(executeMareaCommand).mock.calls[0]?.[0];
    expect(options?.languagePreference).toBe("en");
    expect(options?.translator.locale).toBe("en");
    expect(options?.automaticLocale).toBe("es");
    expect(store.save).not.toHaveBeenCalled();
  },
);

it.each([
  [undefined, join(homedir(), ".marea")],
  ["", join(homedir(), ".marea")],
  [" \t ", join(homedir(), ".marea")],
  [" /tmp/marea-custom-state ", "/tmp/marea-custom-state"],
] as const)("selects the preference store for MAREA_STATE_HOME=%j", async (stateRoot, expected) => {
  vi.resetModules();
  process.argv = ["bun", "marea", "--version"];
  vi.stubEnv("MAREA_LANG", undefined);
  vi.stubEnv("MAREA_STATE_HOME", stateRoot);
  vi.mocked(createStudentLanguagePreferenceStore).mockReturnValue({
    load: vi.fn(() => Promise.resolve(null)),
    save: vi.fn(),
  });

  await import("./marea-entry.boundary.js");

  expect(createStudentLanguagePreferenceStore).toHaveBeenCalledExactlyOnceWith(expected);
});
