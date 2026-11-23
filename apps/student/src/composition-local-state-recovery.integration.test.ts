import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTranslator } from "@marea/i18n";

import { createProductionStudentApplication } from "./composition.js";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { TemporaryDirectories } from "./filesystem-test.fixture.js";
import { FixtureInterface, SESSION_TOKEN } from "./student.fixture.js";

const temporaryDirectories = new TemporaryDirectories();
const ONE_HOUR = 60 * 60 * 1000;
const VALID_SESSION = JSON.stringify({ run: null, version: 2 });
const VALID_CREDENTIAL = JSON.stringify({ token: SESSION_TOKEN });
const NOTICE = createTranslator("es").t("student.cli.local-state-recovered");

afterEach(async () => {
  await temporaryDirectories.removeAll();
});

interface ProductionFixture {
  readonly notices: string[];
  readonly projectRoot: string;
  readonly stateDirectory: string;
}

async function createProductionFixture(name: string): Promise<ProductionFixture> {
  const root = await temporaryDirectories.create(name);
  const projectRoot = join(root, "project");
  const stateDirectory = join(root, "state");
  await mkdir(projectRoot);
  await mkdir(stateDirectory, { mode: 0o700 });
  return { notices: [], projectRoot, stateDirectory };
}

async function startApplication(fixture: ProductionFixture) {
  return createProductionStudentApplication({
    clientVersion: "1.0.0",
    notice: (text) => {
      fixture.notices.push(text);
    },
    projectRoot: fixture.projectRoot,
    serverUrl: "https://teacher.example",
    stateDirectory: fixture.stateDirectory,
    studentInterface: new FixtureInterface(),
    translator: createTranslator("es"),
  });
}

async function ageFile(path: string, ageMilliseconds: number): Promise<void> {
  const stamp = new Date(Date.now() - ageMilliseconds);
  await utimes(path, stamp, stamp);
}

async function quarantineFolders(stateDirectory: string): Promise<readonly string[]> {
  try {
    return await readdir(join(stateDirectory, "quarantine"));
  } catch {
    return [];
  }
}

describe("production composition local state recovery", () => {
  it("sets damaged checkpoints, session and credential state aside and starts", async () => {
    const fixture = await createProductionFixture("composition-recovery");
    const { stateDirectory } = fixture;
    await mkdir(join(stateDirectory, "agent"));
    await writeFile(join(stateDirectory, "agent", "checkpoints.bin"), new Uint8Array([1, 2, 3]));
    await writeFile(join(stateDirectory, "agent", "checkpoints.bin.4c.next"), "partial");
    await writeFile(join(stateDirectory, "session.json"), '{"run":');
    await writeFile(join(stateDirectory, "session.json.7a.tmp"), "partial");
    await writeFile(join(stateDirectory, "credential.json"), '{"token":12}');
    await writeFile(join(stateDirectory, "settings-keep.tmp"), "recent");
    await writeFile(join(stateDirectory, "stale.tmp"), "stale");
    await ageFile(join(stateDirectory, "stale.tmp"), 2 * ONE_HOUR);

    const application = await startApplication(fixture);
    try {
      const report = application.localStateRecovery;
      expect(report.recovered).toBe(true);
      expect(report.diagnosticCode).toBe("local-state.recovered");
      expect(report.files.map((file) => `${file.file}:${file.diagnosticCode}`).toSorted()).toEqual([
        `${join("agent", "checkpoints.bin")}:checkpoint.invalid`,
        "credential.json:credential.invalid",
        "session.json:session.invalid",
      ]);
      expect(report.staleTemporaryFiles).toBe(1);
      expect(fixture.notices).toEqual([NOTICE]);
      expect(NOTICE).not.toContain(stateDirectory);

      const quarantine = report.quarantine;
      if (quarantine === null) throw new Error("Expected a quarantine folder.");
      const moved = join(stateDirectory, quarantine);
      expect((await readdir(moved)).toSorted()).toEqual([
        "agent",
        "credential.json",
        "session.json",
        "session.json.7a.tmp",
      ]);
      expect((await readdir(join(moved, "agent"))).toSorted()).toEqual([
        "checkpoints.bin",
        "checkpoints.bin.4c.next",
      ]);
      expect(await readFile(join(moved, "session.json"), "utf8")).toBe('{"run":');

      // Startup continues with fresh, empty local state and keeps recent leftovers.
      expect(await readFile(join(stateDirectory, "agent", "checkpoints.bin"), "utf8")).toBe("");
      expect((await readdir(stateDirectory)).toSorted()).toEqual([
        "agent",
        "quarantine",
        "settings-keep.tmp",
      ]);
      expect(await quarantineFolders(stateDirectory)).toHaveLength(1);
    } finally {
      application.dispose();
    }
  });

  it("keeps readable local state untouched and stays silent", async () => {
    const fixture = await createProductionFixture("composition-healthy");
    const { stateDirectory } = fixture;
    await writeFile(join(stateDirectory, "session.json"), VALID_SESSION);
    await writeFile(join(stateDirectory, "credential.json"), VALID_CREDENTIAL);

    const application = await startApplication(fixture);
    try {
      expect(application.localStateRecovery).toEqual({
        diagnosticCode: "local-state.recovered",
        files: [],
        quarantine: null,
        recovered: false,
        staleTemporaryFiles: 0,
      });
      expect(fixture.notices).toEqual([]);
      expect(await readFile(join(stateDirectory, "session.json"), "utf8")).toBe(VALID_SESSION);
      expect(await readFile(join(stateDirectory, "credential.json"), "utf8")).toBe(
        VALID_CREDENTIAL,
      );
      expect(await quarantineFolders(stateDirectory)).toEqual([]);
    } finally {
      application.dispose();
    }
  });

  it("migrates a legacy session file instead of setting it aside", async () => {
    const fixture = await createProductionFixture("composition-legacy");
    const { stateDirectory } = fixture;
    await writeFile(
      join(stateDirectory, "session.json"),
      JSON.stringify({ run: null, version: 1 }),
    );

    const application = await startApplication(fixture);
    try {
      expect(application.localStateRecovery.recovered).toBe(false);
      expect(fixture.notices).toEqual([]);
      expect(await readFile(join(stateDirectory, "session.json"), "utf8")).toBe(
        JSON.stringify({ run: null, version: 2 }),
      );
      expect(await quarantineFolders(stateDirectory)).toEqual([]);
    } finally {
      application.dispose();
    }
  });

  it("does not quarantine a checkpoint that is merely unreadable", async () => {
    const fixture = await createProductionFixture("composition-unreadable");
    const { stateDirectory } = fixture;
    await mkdir(join(stateDirectory, "agent"));
    await writeFile(join(stateDirectory, "session.json"), VALID_SESSION);
    // A directory where the checkpoint file belongs is rejected before any read.
    await mkdir(join(stateDirectory, "agent", "checkpoints.bin"));

    await expect(startApplication(fixture)).rejects.toThrow(
      "The checkpoint state must be a regular file.",
    );

    expect(fixture.notices).toEqual([]);
    expect(await quarantineFolders(stateDirectory)).toEqual([]);
    expect(await readFile(join(stateDirectory, "session.json"), "utf8")).toBe(VALID_SESSION);
  });
});

describe("local state temporary files", () => {
  it("ignores leftovers from interrupted atomic writes when loading", async () => {
    const fixture = await createProductionFixture("composition-temporary-leftovers");
    const { projectRoot, stateDirectory } = fixture;
    await writeFile(join(stateDirectory, "session.json"), VALID_SESSION);
    await writeFile(join(stateDirectory, "session.json.ab12.tmp"), "{{{ interrupted");
    await writeFile(join(stateDirectory, "credential.json.cd34.tmp"), "{{{ interrupted");
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });

    expect(await stores.state.load()).toEqual({ run: null, version: 2 });
    expect(await stores.credentials.load()).toBeNull();
    expect((await readdir(stateDirectory)).toSorted()).toEqual([
      "credential.json.cd34.tmp",
      "session.json",
      "session.json.ab12.tmp",
    ]);
  });
});
