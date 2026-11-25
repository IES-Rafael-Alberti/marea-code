import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTranslator } from "@marea/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commandOptions, idleRuntime } from "./command-options.fixture.js";
import { runLogoutCommand } from "./logout-command.boundary.js";
import { createStudentStateDirectory, executeMareaCommand } from "./marea-command.boundary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directories() {
  const root = mkdtempSync(join(tmpdir(), "marea-logout-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const stateDirectory = join(root, "state");
  mkdirSync(projectRoot);
  mkdirSync(stateDirectory);
  return { projectRoot, stateDirectory };
}

function run(locations: ReturnType<typeof directories>, locale: "es" | "en" = "es") {
  const writes: string[] = [];
  const result = runLogoutCommand({
    ...locations,
    translator: createTranslator(locale),
    output: { write: (text) => writes.push(text) },
  });
  return { result, writes };
}

describe("marea logout", () => {
  it("forgets the stored sign-in and keeps the session state", async () => {
    const locations = directories();
    const credential = join(locations.stateDirectory, "credential.json");
    const session = join(locations.stateDirectory, "session.json");
    writeFileSync(credential, "{}");
    writeFileSync(session, '{"kept":true}');
    const { result, writes } = run(locations);
    expect(await result).toBe(0);
    expect(existsSync(credential)).toBe(false);
    expect(readFileSync(session, "utf8")).toBe('{"kept":true}');
    expect(writes).toEqual([
      "Sesión cerrada. La próxima vez que ejecutes marea podrás elegir cómo iniciar sesión.\n",
    ]);
  });

  it("succeeds with the same message when there was no sign-in", async () => {
    const first = run(directories(), "en");
    expect(await first.result).toBe(0);
    expect(first.writes).toEqual([
      "Signed out. The next time you run marea you can choose how to sign in.\n",
    ]);
  });

  it("is dispatched for this server and project without opening a conversation", async () => {
    const options = commandOptions({
      arguments: ["logout"],
      serverUrl: " https://teacher.example ",
    });
    const logout = vi.fn().mockResolvedValue(0);
    const runtime = idleRuntime();
    expect(await executeMareaCommand(options, runtime, vi.fn(), logout)).toBe(0);
    expect(logout).toHaveBeenCalledWith({
      projectRoot: resolve(options.currentDirectory),
      stateDirectory: createStudentStateDirectory(
        join(options.homeDirectory, ".marea"),
        "https://teacher.example",
        options.currentDirectory,
      ),
      translator: options.translator,
      output: options.output,
    });
    expect(runtime.createApplication).not.toHaveBeenCalled();
    expect(runtime.startConversation).not.toHaveBeenCalled();
  });
});
