import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CURRENT_STUDENT_STATE_VERSION } from "./contracts.js";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { TemporaryDirectories } from "./filesystem-test.fixture.js";

const temporaryDirectories = new TemporaryDirectories();
afterEach(async () => {
  await temporaryDirectories.removeAll();
});

it("allows twenty MiB of session state and diagnoses larger files without deleting them", async () => {
  const root = await temporaryDirectories.create("large-state");
  const projectRoot = join(root, "project");
  const stateDirectory = join(root, "state");
  await mkdir(projectRoot);
  const stores = await createFileStudentStores({ projectRoot, stateDirectory });
  const path = join(stateDirectory, "session.json");
  const state = { run: null, version: CURRENT_STUDENT_STATE_VERSION };
  const content = JSON.stringify(state).padEnd(20 * 1_048_576, " ");
  await writeFile(path, content);
  await expect(stores.state.load()).resolves.toEqual(state);
  await writeFile(path, content + " ");
  await expect(stores.state.load()).rejects.toMatchObject({
    name: "StudentStateFileTooLargeError",
    message: "Student state file exceeds its size limit.",
    diagnosticCode: "local-state.too-large",
  });
  expect((await lstat(path)).size).toBe(20 * 1_048_576 + 1);
});
