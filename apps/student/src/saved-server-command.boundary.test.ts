import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  commandOptions,
  conversationSession,
  idleRuntime,
  testConversationRuntime,
} from "./command-options.fixture.js";
import { createStudentStateDirectory, executeMareaCommand } from "./marea-command.boundary.js";
import type { LogoutCommandOptions } from "./logout-command.boundary.js";
import type { MareaCommandRuntime } from "./marea-command.boundary.js";
import { createSavedServerStore, type SavedServerStore } from "./saved-server.boundary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "marea-saved-command-"));
  roots.push(root);
  return root;
}

/** A runtime whose connection works, or fails before the run opens when `reachable` is false. */
function runtime(reachable = true) {
  const createApplication = vi.fn<MareaCommandRuntime["createApplication"]>(() => {
    return Promise.resolve({
      controller: {
        pendingTurn: () => Promise.resolve(null),
        start: () =>
          reachable ? Promise.resolve({}) : Promise.reject(new Error("connection refused")),
        close: () => Promise.resolve(),
        sendMessage: () => Promise.resolve(),
      },
      dispose: vi.fn(),
    });
  });
  const value: MareaCommandRuntime = {
    ...testConversationRuntime(() => Promise.resolve(conversationSession())),
    createApplication,
  };
  return { createApplication, value };
}

const environment = "https://install.example";
const flagged = "http://192.168.1.20:18787";

it("remembers the server of a successful --server and uses it next time, even in a new shell", async () => {
  const root = stateRoot();
  const store = () => createSavedServerStore(root);
  const first = runtime();
  const firstOptions = commandOptions({
    arguments: ["--server", flagged],
    serverUrl: environment,
    stateRoot: root,
    savedServerStore: store(),
  });
  expect(await executeMareaCommand(firstOptions, first.value)).toBe(0);
  expect(first.createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: flagged }),
  );
  expect(firstOptions.writes[0]).toBe(`Connecting to ${flagged}…\n`);

  const second = runtime();
  const secondOptions = commandOptions({
    serverUrl: environment,
    stateRoot: root,
    savedServerStore: store(),
  });
  expect(await executeMareaCommand(secondOptions, second.value)).toBe(0);
  expect(second.createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: flagged }),
  );
  expect(secondOptions.writes[0]).toBe(`Connecting to ${flagged}…\n`);
});

it("lets --server override the saved server and replaces it after a good connection", async () => {
  const root = stateRoot();
  const store = createSavedServerStore(root);
  await store.save(flagged);
  const run = runtime();
  expect(
    await executeMareaCommand(
      commandOptions({
        arguments: [`--server=https://other.example`],
        serverUrl: environment,
        stateRoot: root,
        savedServerStore: store,
      }),
      run.value,
    ),
  ).toBe(0);
  expect(run.createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "https://other.example" }),
  );
  expect(await store.load()).toBe("https://other.example");
});

it("never saves a server that failed to connect and keeps the earlier one", async () => {
  const root = stateRoot();
  const store = createSavedServerStore(root);
  await store.save(flagged);
  const run = runtime(false);
  const options = commandOptions({
    arguments: ["--server", "https://down.example"],
    serverUrl: environment,
    stateRoot: root,
    savedServerStore: store,
  });
  expect(await executeMareaCommand(options, run.value)).toBe(1);
  expect(await store.load()).toBe(flagged);
});

it("does not pin the installer's server: only an explicit --server is saved", async () => {
  const root = stateRoot();
  const store = createSavedServerStore(root);
  const run = runtime();
  expect(
    await executeMareaCommand(
      commandOptions({ serverUrl: environment, stateRoot: root, savedServerStore: store }),
      run.value,
    ),
  ).toBe(0);
  expect(run.createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: environment }),
  );
  expect(await store.load()).toBeUndefined();
});

it("falls back to the installer's server when the saved file is corrupt", async () => {
  const root = stateRoot();
  writeFileSync(join(root, "server.json"), "{ corrupt");
  const run = runtime();
  expect(
    await executeMareaCommand(
      commandOptions({
        serverUrl: environment,
        stateRoot: root,
        savedServerStore: createSavedServerStore(root),
      }),
      run.value,
    ),
  ).toBe(0);
  expect(run.createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: environment }),
  );
  expect(readFileSync(join(root, "server-problems.jsonl"), "utf8")).toContain("saved-server");
});

it("reports an unreachable saved server as a normal connection error, which --server bypasses", async () => {
  const root = stateRoot();
  const store = createSavedServerStore(root);
  await store.save("https://down.example");
  const down = runtime(false);
  const options = commandOptions({ stateRoot: root, savedServerStore: store });
  expect(await executeMareaCommand(options, down.value)).toBe(1);
  expect(down.createApplication).toHaveBeenCalledWith(
    expect.objectContaining({ serverUrl: "https://down.example" }),
  );
  expect(options.writes[0]).toBe("Connecting to https://down.example…\n");
  expect(options.errors).toHaveLength(1);

  const up = runtime();
  expect(
    await executeMareaCommand(
      commandOptions({
        arguments: ["--server", flagged],
        stateRoot: root,
        savedServerStore: store,
      }),
      up.value,
    ),
  ).toBe(0);
  expect(await store.load()).toBe(flagged);
});

it("still starts when the server cannot be remembered", async () => {
  const save = vi.fn(() => Promise.reject(new Error("read-only disk")));
  const savedServerStore: SavedServerStore = { load: () => Promise.resolve(undefined), save };
  const run = runtime();
  expect(
    await executeMareaCommand(
      commandOptions({ arguments: ["--server", flagged], savedServerStore }),
      run.value,
    ),
  ).toBe(0);
  expect(save).toHaveBeenCalledExactlyOnceWith(flagged);
});

it("uses the saved server for feedback and logout state, and logout keeps it", async () => {
  const root = stateRoot();
  const store = createSavedServerStore(root);
  await store.save(flagged);
  const logout = vi.fn<(options: LogoutCommandOptions) => Promise<number>>(() =>
    Promise.resolve(0),
  );
  const feedback = vi.fn(() => Promise.resolve(0));
  const options = commandOptions({
    arguments: ["logout"],
    currentDirectory: join(root, "project"),
    stateRoot: root,
    serverUrl: environment,
    savedServerStore: store,
  });
  expect(await executeMareaCommand(options, idleRuntime(), feedback, logout)).toBe(0);
  const logoutOptions = logout.mock.calls[0]?.[0];
  expect(logoutOptions?.stateDirectory).toBe(
    createStudentStateDirectory(root, flagged, join(root, "project")),
  );
  expect(await store.load()).toBe(flagged);
  expect(
    await executeMareaCommand(
      commandOptions({
        arguments: ["feedback"],
        stateRoot: root,
        serverUrl: environment,
        savedServerStore: store,
      }),
      idleRuntime(),
      feedback,
      logout,
    ),
  ).toBe(0);
  expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: flagged }));
});

it("does not read the saved file for help or version", async () => {
  const load = vi.fn(() => Promise.resolve(flagged));
  const savedServerStore: SavedServerStore = { load, save: vi.fn() };
  for (const argument of ["--help", "--version"])
    await executeMareaCommand(
      commandOptions({ arguments: [argument], savedServerStore }),
      idleRuntime(),
    );
  expect(load).not.toHaveBeenCalled();
});

it("starts normally with an explicit --server when no place to remember it was given", async () => {
  const run = runtime();
  expect(
    await executeMareaCommand(commandOptions({ arguments: ["--server", flagged] }), run.value),
  ).toBe(0);
});
