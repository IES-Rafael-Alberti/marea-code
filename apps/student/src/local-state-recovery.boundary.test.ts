import { lstat, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@marea/i18n";
import { AgentAdapterError } from "@marea/deepagents-adapter";
import { ZodError } from "zod";

import { TemporaryDirectories } from "./filesystem-test.fixture.js";
import {
  createLocalStateRecovery,
  createNodeLocalStateFileSystem,
  isDamagedCheckpointState,
  LocalStateQuarantineError,
  type LocalStateRecoveryFileSystem,
} from "./local-state-recovery.boundary.js";

const temporaryDirectories = new TemporaryDirectories();
const NOW = new Date("2026-10-05T12:00:00.000Z");
const ONE_HOUR = 60 * 60 * 1000;
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const RECOVERY_MESSAGE_KEY = "student.cli.local-state-recovered" as const;

/** Stands in for the typed private-filesystem failures reported by the ACL boundary. */
class PrivateFilesystemFailure extends Error {
  readonly diagnosticCode = "private-fs.timeout";

  constructor() {
    super("Private filesystem permissions could not be established.");
    this.name = "PrivateFilesystemFailure";
  }
}

afterEach(async () => {
  await temporaryDirectories.removeAll();
});

async function createStateDirectory(name: string): Promise<string> {
  const root = await temporaryDirectories.create(name);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  return stateDirectory;
}

async function writeAged(path: string, content: string, ageMilliseconds: number): Promise<void> {
  await writeFile(path, content);
  const stamp = new Date(NOW.getTime() - ageMilliseconds);
  await utimes(path, stamp, stamp);
}

function damaged(reason: "session" | "credential") {
  const failure =
    reason === "session" ? new SyntaxError("Unexpected end of JSON input") : new ZodError([]);
  return {
    file: reason === "session" ? "session.json" : "credential.json",
    load: () => Promise.reject(failure),
    reason,
  };
}

/** A probe failure that is not damaged content must reach the caller unchanged. */
async function expectProbeFailureToPropagate(failure: Error | string): Promise<void> {
  const stateDirectory = await createStateDirectory("recovery-other-failure");
  await writeFile(join(stateDirectory, "session.json"), "{}");
  const recovery = createLocalStateRecovery({
    probes: [
      {
        file: "session.json",
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point is an untyped rejection.
        load: () => Promise.reject(failure),
        reason: "session",
      },
    ],
    stateDirectory,
  });

  await expect(recovery.prepare()).rejects.toBe(failure);

  expect((await readdir(stateDirectory)).toSorted()).toEqual(["session.json"]);
  expect(recovery.report().recovered).toBe(false);
}

function withFileSystem(
  overrides: Partial<LocalStateRecoveryFileSystem>,
): LocalStateRecoveryFileSystem {
  return { ...createNodeLocalStateFileSystem(), ...overrides };
}

describe("local state recovery", () => {
  it("sets a damaged state file aside with its temporary siblings", async () => {
    const stateDirectory = await createStateDirectory("recovery-session");
    await writeAged(join(stateDirectory, "session.json"), '{"run":', 0);
    await writeAged(join(stateDirectory, "session.json.7f3a.tmp"), "partial", 0);
    await writeAged(join(stateDirectory, "credential.json"), '{"token":"t"}', 0);
    await mkdir(join(stateDirectory, "session.json.9b.tmp"));
    const notices: string[] = [];
    const recovery = createLocalStateRecovery({
      nextQuarantineId: () => "id1",
      notice: (text) => {
        notices.push(text);
      },
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
      translator: createTranslator("en"),
    });

    await recovery.prepare();
    await recovery.announce();

    const quarantine = join(stateDirectory, "quarantine", "2026-10-05T12.00.00.000Z-id1");
    expect((await readdir(stateDirectory)).toSorted()).toEqual([
      "credential.json",
      "quarantine",
      "session.json.9b.tmp",
    ]);
    expect((await readdir(quarantine)).toSorted()).toEqual([
      "session.json",
      "session.json.7f3a.tmp",
    ]);
    expect(await readFile(join(quarantine, "session.json"), "utf8")).toBe('{"run":');
    expect((await lstat(quarantine)).mode & 0o777).toBe(0o700);
    expect(notices).toEqual([createTranslator("en").t(RECOVERY_MESSAGE_KEY)]);
    expect(recovery.report()).toEqual({
      diagnosticCode: "local-state.recovered",
      files: [{ diagnosticCode: "session.invalid", file: "session.json", reason: "session" }],
      quarantine: join("quarantine", "2026-10-05T12.00.00.000Z-id1"),
      recovered: true,
      staleTemporaryFiles: 0,
    });
    expect(recovery.report().diagnosticCode).toMatch(DIAGNOSTIC_CODE_PATTERN);
  });

  it("reuses one quarantine folder for every damaged file", async () => {
    const stateDirectory = await createStateDirectory("recovery-shared-folder");
    await writeFile(join(stateDirectory, "session.json"), "{}");
    await writeFile(join(stateDirectory, "credential.json"), "{}");
    const recovery = createLocalStateRecovery({
      nextQuarantineId: () => "id2",
      now: () => NOW,
      probes: [damaged("session"), damaged("credential")],
      stateDirectory,
    });

    await recovery.prepare();

    const report = recovery.report();
    expect(report.quarantine).toBe(join("quarantine", "2026-10-05T12.00.00.000Z-id2"));
    expect(report.files.map((file) => file.diagnosticCode)).toEqual([
      "session.invalid",
      "credential.invalid",
    ]);
    const quarantine = report.quarantine;
    if (quarantine === null) throw new Error("Expected a quarantine folder.");
    expect((await readdir(join(stateDirectory, quarantine))).toSorted()).toEqual([
      "credential.json",
      "session.json",
    ]);
    expect(await readdir(join(stateDirectory, "quarantine"))).toHaveLength(1);
  });

  it("sets the durable checkpoint aside inside its own folder", async () => {
    const stateDirectory = await createStateDirectory("recovery-checkpoint");
    await mkdir(join(stateDirectory, "agent"));
    await writeFile(join(stateDirectory, "agent", "checkpoints.bin"), "damaged");
    await writeFile(join(stateDirectory, "agent", "checkpoints.bin.9.next"), "partial");
    await writeFile(join(stateDirectory, "agent", "keep.txt"), "keep");
    const recovery = createLocalStateRecovery({
      nextQuarantineId: () => "id3",
      now: () => NOW,
      stateDirectory,
    });

    await recovery.quarantineCheckpointState();

    const quarantine = join(stateDirectory, "quarantine", "2026-10-05T12.00.00.000Z-id3", "agent");
    expect((await readdir(quarantine)).toSorted()).toEqual([
      "checkpoints.bin",
      "checkpoints.bin.9.next",
    ]);
    expect((await readdir(join(stateDirectory, "agent"))).toSorted()).toEqual(["keep.txt"]);
    expect((await lstat(quarantine)).mode & 0o777).toBe(0o700);
    expect(recovery.report().files).toEqual([
      {
        diagnosticCode: "checkpoint.invalid",
        file: join("agent", "checkpoints.bin"),
        reason: "checkpoint",
      },
    ]);
  });

  it("ignores temporary siblings it cannot stat as regular files", async () => {
    const stateDirectory = await createStateDirectory("recovery-unreadable-sibling");
    const node = createNodeLocalStateFileSystem();
    await writeFile(join(stateDirectory, "session.json"), "{}");
    await writeFile(join(stateDirectory, "session.json.gone.tmp"), "partial");
    const recovery = createLocalStateRecovery({
      filesystem: withFileSystem({
        inspect: (path) => (path.endsWith(".tmp") ? Promise.resolve(null) : node.inspect(path)),
      }),
      nextQuarantineId: () => "id4",
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
    });

    await recovery.prepare();

    expect((await readdir(stateDirectory)).toSorted()).toEqual([
      "quarantine",
      "session.json.gone.tmp",
    ]);
    expect(
      (
        await readdir(join(stateDirectory, "quarantine", "2026-10-05T12.00.00.000Z-id4"))
      ).toSorted(),
    ).toEqual(["session.json"]);
    expect(recovery.report().staleTemporaryFiles).toBe(0);
  });

  it("removes temporary files older than one hour and keeps everything else", async () => {
    const stateDirectory = await createStateDirectory("recovery-temporary");
    await mkdir(join(stateDirectory, "agent"));
    await mkdir(join(stateDirectory, "stale-dir.tmp"));
    await writeAged(join(stateDirectory, "session.json.old.tmp"), "{}", 2 * ONE_HOUR);
    await writeAged(join(stateDirectory, "agent", "checkpoints.bin.old.next"), "x", 90 * 60 * 1000);
    await writeAged(join(stateDirectory, "session.json.new.tmp"), "{}", 5 * 60 * 1000);
    await writeAged(join(stateDirectory, "session.json"), "{}", 3 * ONE_HOUR);
    await utimes(
      join(stateDirectory, "stale-dir.tmp"),
      NOW,
      new Date(NOW.getTime() - 2 * ONE_HOUR),
    );
    const notices: string[] = [];
    const recovery = createLocalStateRecovery({
      notice: (text) => {
        notices.push(text);
      },
      now: () => NOW,
      stateDirectory,
      translator: createTranslator("es"),
    });

    await recovery.prepare();
    await recovery.announce();

    expect((await readdir(stateDirectory)).toSorted()).toEqual([
      "agent",
      "session.json",
      "session.json.new.tmp",
      "stale-dir.tmp",
    ]);
    expect((await readdir(join(stateDirectory, "agent"))).toSorted()).toEqual([]);
    expect(recovery.report()).toEqual({
      diagnosticCode: "local-state.recovered",
      files: [],
      quarantine: null,
      recovered: false,
      staleTemporaryFiles: 2,
    });
    expect(notices).toEqual([]);
  });

  it("keeps startup alive when temporary cleanup fails", async () => {
    const stateDirectory = await createStateDirectory("recovery-cleanup-failure");
    const recovery = createLocalStateRecovery({
      filesystem: withFileSystem({
        list: () => Promise.reject(new Error("EIO: directory unreadable")),
      }),
      now: () => NOW,
      stateDirectory,
    });

    await recovery.prepare();

    expect(recovery.report().staleTemporaryFiles).toBe(0);
  });

  it("rethrows a typed private filesystem failure without quarantining", async () => {
    await expectProbeFailureToPropagate(new PrivateFilesystemFailure());
  });

  it("rethrows a plain error instead of setting state aside", async () => {
    await expectProbeFailureToPropagate(
      new Error("Student state file is unsafe or exceeds its size limit."),
    );
  });

  it("rethrows an untyped rejection instead of setting state aside", async () => {
    await expectProbeFailureToPropagate("session.json exploded");
  });

  it("rethrows an error whose diagnostic code is not normalized", async () => {
    await expectProbeFailureToPropagate(
      Object.assign(new Error("blocked"), { diagnosticCode: "Private FS!" }),
    );
  });

  it("reports a typed failure and preserves the data when quarantine cannot move", async () => {
    const stateDirectory = await createStateDirectory("recovery-quarantine-failure");
    await writeFile(join(stateDirectory, "session.json"), '{"run":');
    const failure = new Error("EPERM: operation not permitted");
    const recovery = createLocalStateRecovery({
      filesystem: withFileSystem({ move: () => Promise.reject(failure) }),
      nextQuarantineId: () => "id5",
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
    });

    let quarantineFailure: LocalStateQuarantineError | null = null;
    try {
      await recovery.prepare();
    } catch (error) {
      if (error instanceof LocalStateQuarantineError) quarantineFailure = error;
      else throw error;
    }

    expect(quarantineFailure?.diagnosticCode).toBe("local-state.quarantine-failed");
    expect(quarantineFailure?.diagnosticCode).toMatch(DIAGNOSTIC_CODE_PATTERN);
    expect(quarantineFailure?.cause).toBe(failure);
    expect(quarantineFailure?.message).not.toContain(stateDirectory);
    expect(await readFile(join(stateDirectory, "session.json"), "utf8")).toBe('{"run":');
    expect(recovery.report().recovered).toBe(false);
  });

  it("keeps the private filesystem code when creating the quarantine folder fails", async () => {
    const stateDirectory = await createStateDirectory("recovery-folder-failure");
    await writeFile(join(stateDirectory, "session.json"), "{}");
    const failure = new PrivateFilesystemFailure();
    const recovery = createLocalStateRecovery({
      filesystem: withFileSystem({ secureDirectory: () => Promise.reject(failure) }),
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
    });

    await expect(recovery.prepare()).rejects.toBe(failure);
    expect(recovery.report().recovered).toBe(false);
  });

  it("reports a typed failure when the quarantine folder cannot be created", async () => {
    const stateDirectory = await createStateDirectory("recovery-folder-error");
    await writeFile(join(stateDirectory, "session.json"), '{"run":');
    const failure = new Error("ENOSPC: no space left on device");
    const recovery = createLocalStateRecovery({
      filesystem: withFileSystem({ secureDirectory: () => Promise.reject(failure) }),
      nextQuarantineId: () => "id10",
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
    });

    await expect(recovery.prepare()).rejects.toMatchObject({
      cause: failure,
      diagnosticCode: "local-state.quarantine-failed",
      name: "LocalStateQuarantineError",
    });
    expect(await readFile(join(stateDirectory, "session.json"), "utf8")).toBe('{"run":');
    expect(recovery.report().recovered).toBe(false);
  });

  it("keeps the private filesystem code when moving into quarantine fails", async () => {
    const stateDirectory = await createStateDirectory("recovery-move-failure");
    await writeFile(join(stateDirectory, "session.json"), "{}");
    const failure = new PrivateFilesystemFailure();
    const recovery = createLocalStateRecovery({
      filesystem: withFileSystem({ move: () => Promise.reject(failure) }),
      nextQuarantineId: () => "id6",
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
    });

    await expect(recovery.prepare()).rejects.toBe(failure);
  });

  it("announces once in the language resolved from the environment", async () => {
    const stateDirectory = await createStateDirectory("recovery-notice");
    const homeDirectory = await temporaryDirectories.create("recovery-home");
    await writeFile(join(stateDirectory, "session.json"), "{}");
    const notices: string[] = [];
    const recovery = createLocalStateRecovery({
      environment: { MAREA_LANG: "en" },
      homeDirectory,
      nextQuarantineId: () => "id7",
      notice: (text) => {
        notices.push(text);
      },
      now: () => NOW,
      probes: [damaged("session")],
      stateDirectory,
    });

    await recovery.prepare();
    await recovery.announce();
    await recovery.announce();

    expect(notices).toEqual([createTranslator("en").t(RECOVERY_MESSAGE_KEY)]);
  });

  it("announces with the saved interface language from the configured state root", async () => {
    const stateDirectory = await createStateDirectory("recovery-saved-language");
    const stateRoot = await temporaryDirectories.create("recovery-state-root");
    await writeFile(
      join(stateRoot, "settings.json"),
      JSON.stringify({ "marea.interface-language.v1": "eu" }),
    );
    await writeFile(join(stateDirectory, "credential.json"), "{}");
    const notices: string[] = [];
    const recovery = createLocalStateRecovery({
      environment: { MAREA_STATE_HOME: stateRoot },
      homeDirectory: join(stateRoot, "unused-home"),
      nextQuarantineId: () => "id8",
      notice: (text) => {
        notices.push(text);
      },
      now: () => NOW,
      probes: [damaged("credential")],
      stateDirectory,
    });

    await recovery.prepare();
    await recovery.announce();

    expect(notices).toEqual([createTranslator("eu").t(RECOVERY_MESSAGE_KEY)]);
  });

  it("writes the notice to the start output when no sink is given", async () => {
    const stateDirectory = await createStateDirectory("recovery-stdout");
    await writeFile(join(stateDirectory, "session.json"), "{}");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const recovery = createLocalStateRecovery({
        environment: { MAREA_LANG: "es" },
        homeDirectory: stateDirectory,
        nextQuarantineId: () => "id9",
        now: () => NOW,
        probes: [damaged("session")],
        stateDirectory,
      });

      await recovery.prepare();
      await recovery.announce();

      expect(write).toHaveBeenCalledExactlyOnceWith(
        `${createTranslator("es").t(RECOVERY_MESSAGE_KEY)}\n`,
      );
    } finally {
      write.mockRestore();
    }
  });
});

describe("damaged checkpoint classification", () => {
  it("recognizes only the adapter's invalid checkpoint state", () => {
    expect(
      isDamagedCheckpointState(new AgentAdapterError("invalid-checkpoint-state", "damaged")),
    ).toBe(true);
    expect(
      isDamagedCheckpointState(new AgentAdapterError("invalid-runtime-dependency", "unreadable")),
    ).toBe(false);
    expect(isDamagedCheckpointState(new Error("invalid-checkpoint-state"))).toBe(false);
  });
});
