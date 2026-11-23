import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { AgentAdapterError } from "@marea/deepagents-adapter";
import { createTranslator, type Translator } from "@marea/i18n";
import { securePrivatePath } from "@marea/private-filesystem";
import { ZodError } from "zod";

import { isMissingFile } from "./filesystem.boundary.js";
import {
  createStudentLanguagePreferenceStore,
  resolveStudentLocale,
  systemLocaleCandidates,
} from "./interface-locale.boundary.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const QUARANTINE_DIRECTORY_NAME = "quarantine";
const STALE_TEMPORARY_AGE_MILLISECONDS = 60 * 60 * 1000;
/** Atomic writes leave `<name>.<id>.tmp`; durable checkpoints leave `<name>.<id>.next`. */
const TEMPORARY_NAME_PATTERN = /\.(?:tmp|next)$/u;
/** Shared diagnostic-code shape: lowercase alphanumeric segments joined by `.` or `-`. */
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
/** The adapter stores its durable checkpoint here, relative to the state directory. */
const CHECKPOINT_STATE_FILE = join("agent", "checkpoints.bin");
const LOCAL_STATE_RECOVERED_CODE = "local-state.recovered";
const RECOVERY_DIAGNOSTIC_CODES: Readonly<Record<LocalStateRecoveryReason, string>> = Object.freeze(
  {
    checkpoint: "checkpoint.invalid",
    credential: "credential.invalid",
    session: "session.invalid",
  },
);

/**
 * Quarantine could not preserve damaged state. Startup stays blocked instead of
 * continuing without the student's data, and the printed code carries no paths.
 */
export class LocalStateQuarantineError extends Error {
  readonly diagnosticCode = "local-state.quarantine-failed";

  constructor(cause: unknown) {
    super("Damaged local state could not be set aside for recovery.", { cause });
    this.name = "LocalStateQuarantineError";
  }
}

type LocalStateRecoveryReason = "checkpoint" | "credential" | "session";

interface RecoveredLocalStateFile {
  readonly diagnosticCode: string;
  readonly file: string;
  readonly reason: LocalStateRecoveryReason;
}

export interface LocalStateRecoveryReport {
  /** Diagnostics code for the recovery event; log it only when `recovered`. */
  readonly diagnosticCode: string;
  readonly files: readonly RecoveredLocalStateFile[];
  /** State-directory relative quarantine folder, or `null` when nothing moved. */
  readonly quarantine: string | null;
  readonly recovered: boolean;
  readonly staleTemporaryFiles: number;
}

interface LocalStateFileStatus {
  readonly modifiedAt: number;
  readonly regularFile: boolean;
}

/** Port over the private state directory so failure paths stay testable. */
export interface LocalStateRecoveryFileSystem {
  inspect(path: string): Promise<LocalStateFileStatus | null>;
  list(directory: string): Promise<readonly string[]>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  secureDirectory(path: string): Promise<void>;
}

interface LocalStateProbe {
  /** State-directory relative file the probe validates. */
  readonly file: string;
  readonly load: () => Promise<unknown>;
  readonly reason: LocalStateRecoveryReason;
}

export interface LocalStateRecoveryOptions {
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  readonly filesystem?: LocalStateRecoveryFileSystem | undefined;
  readonly homeDirectory?: string | undefined;
  readonly nextQuarantineId?: (() => string) | undefined;
  readonly notice?: ((text: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly probes?: readonly LocalStateProbe[] | undefined;
  readonly stateDirectory: string;
  readonly translator?: Translator | undefined;
}

export interface LocalStateRecovery {
  /** Announce the recovery once, in the student's language, without paths. */
  announce(): Promise<void>;
  /** Set the durable checkpoint aside after the adapter rejected its state. */
  quarantineCheckpointState(): Promise<void>;
  /** Clean interrupted atomic writes, then quarantine unreadable state files. */
  prepare(): Promise<void>;
  report(): LocalStateRecoveryReport;
}

export function createNodeLocalStateFileSystem(): LocalStateRecoveryFileSystem {
  return Object.freeze({
    async inspect(path: string): Promise<LocalStateFileStatus | null> {
      try {
        const status = await lstat(path);
        return Object.freeze({ modifiedAt: status.mtimeMs, regularFile: status.isFile() });
      } catch (error: unknown) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
    async list(directory: string): Promise<readonly string[]> {
      try {
        return await readdir(directory);
      } catch (error: unknown) {
        if (isMissingFile(error)) return Object.freeze([]);
        throw error;
      }
    },
    move: (source: string, destination: string) => rename(source, destination),
    remove: (path: string) => rm(path),
    async secureDirectory(path: string): Promise<void> {
      await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      securePrivatePath(path, PRIVATE_DIRECTORY_MODE);
    },
  });
}

export function createLocalStateRecovery(options: LocalStateRecoveryOptions): LocalStateRecovery {
  return new LocalStateRecoverySession(options);
}

/**
 * The adapter reports damaged durable state with this code. An unreadable
 * checkpoint keeps its filesystem or dependency error, so it is never set aside.
 */
export function isDamagedCheckpointState(error: unknown): boolean {
  return error instanceof AgentAdapterError && error.code === "invalid-checkpoint-state";
}

class LocalStateRecoverySession implements LocalStateRecovery {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #filesystem: LocalStateRecoveryFileSystem;
  readonly #homeDirectory: string;
  readonly #nextQuarantineId: () => string;
  readonly #notice: (text: string) => void;
  readonly #now: () => Date;
  readonly #probes: readonly LocalStateProbe[];
  readonly #recovered: RecoveredLocalStateFile[] = [];
  readonly #stateDirectory: string;
  readonly #translator: Translator | undefined;
  #announced = false;
  #quarantine: string | null = null;
  #staleTemporaryFiles = 0;

  constructor(options: LocalStateRecoveryOptions) {
    this.#environment = options.environment ?? process.env;
    this.#filesystem = options.filesystem ?? createNodeLocalStateFileSystem();
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#nextQuarantineId = options.nextQuarantineId ?? randomUUID;
    this.#notice = options.notice ?? writeStartOutput;
    this.#now = options.now ?? systemNow;
    this.#probes = options.probes ?? Object.freeze([]);
    this.#stateDirectory = options.stateDirectory;
    this.#translator = options.translator;
  }

  async announce(): Promise<void> {
    if (this.#announced || this.#recovered.length === 0) return;
    this.#announced = true;
    const translator =
      this.#translator ?? (await createStartupTranslator(this.#environment, this.#homeDirectory));
    this.#notice(translator.t("student.cli.local-state-recovered"));
  }

  async prepare(): Promise<void> {
    await this.#cleanStaleTemporaryFiles();
    for (const probe of this.#probes) {
      try {
        await probe.load();
      } catch (error: unknown) {
        if (!isRecoverableStateFailure(error)) throw error;
        await this.#quarantineFile(probe.file, probe.reason);
      }
    }
  }

  async quarantineCheckpointState(): Promise<void> {
    await this.#quarantineFile(CHECKPOINT_STATE_FILE, "checkpoint");
  }

  report(): LocalStateRecoveryReport {
    return Object.freeze({
      diagnosticCode: LOCAL_STATE_RECOVERED_CODE,
      files: Object.freeze([...this.#recovered]),
      quarantine: this.#quarantine,
      recovered: this.#recovered.length > 0,
      staleTemporaryFiles: this.#staleTemporaryFiles,
    });
  }

  /** Leftovers from interrupted atomic writes never block or fail a startup. */
  async #cleanStaleTemporaryFiles(): Promise<void> {
    const oldestKept = this.#now().getTime() - STALE_TEMPORARY_AGE_MILLISECONDS;
    let removed = 0;
    try {
      for (const directory of scannedDirectories(this.#stateDirectory)) {
        for (const name of await this.#filesystem.list(directory)) {
          if (await this.#removeStaleTemporaryFile(join(directory, name), oldestKept)) removed += 1;
        }
      }
    } catch {
      // Cleanup is best effort; leftover temporary files stay for the next start.
    }
    this.#staleTemporaryFiles = removed;
  }

  async #removeStaleTemporaryFile(path: string, oldestKept: number): Promise<boolean> {
    if (!TEMPORARY_NAME_PATTERN.test(basename(path))) return false;
    const status = await this.#filesystem.inspect(path);
    if (status === null || !status.regularFile || status.modifiedAt > oldestKept) return false;
    await this.#filesystem.remove(path);
    return true;
  }

  async #quarantineFile(relativePath: string, reason: LocalStateRecoveryReason): Promise<void> {
    const quarantine = await this.#quarantineFolder();
    const source = join(this.#stateDirectory, relativePath);
    const sourceDirectory = dirname(source);
    const destination = join(quarantine, dirname(relativePath));
    try {
      if (dirname(relativePath) !== ".") await this.#filesystem.secureDirectory(destination);
      const siblings = await this.#temporarySiblings(sourceDirectory, basename(source));
      for (const path of [source, ...siblings]) {
        await this.#filesystem.move(path, join(destination, basename(path)));
      }
    } catch (error: unknown) {
      // A typed private-filesystem failure keeps its own diagnostic code.
      if (isPrivateFilesystemFailure(error)) throw error;
      throw new LocalStateQuarantineError(error);
    }
    this.#recovered.push(
      Object.freeze({
        diagnosticCode: RECOVERY_DIAGNOSTIC_CODES[reason],
        file: relativePath,
        reason,
      }),
    );
  }

  async #quarantineFolder(): Promise<string> {
    if (this.#quarantine !== null) return join(this.#stateDirectory, this.#quarantine);
    // Colons are replaced so the folder name stays valid on Windows.
    const stamp = this.#now().toISOString().replaceAll(":", ".");
    const quarantine = join(QUARANTINE_DIRECTORY_NAME, `${stamp}-${this.#nextQuarantineId()}`);
    try {
      await this.#filesystem.secureDirectory(join(this.#stateDirectory, quarantine));
    } catch (error: unknown) {
      if (isPrivateFilesystemFailure(error)) throw error;
      throw new LocalStateQuarantineError(error);
    }
    this.#quarantine = quarantine;
    return join(this.#stateDirectory, quarantine);
  }

  async #temporarySiblings(directory: string, name: string): Promise<readonly string[]> {
    const prefix = `${name}.`;
    const siblings: string[] = [];
    for (const candidate of (await this.#filesystem.list(directory)).toSorted()) {
      if (!candidate.startsWith(prefix) || !TEMPORARY_NAME_PATTERN.test(candidate)) continue;
      const path = join(directory, candidate);
      const status = await this.#filesystem.inspect(path);
      if (status?.regularFile === true) siblings.push(path);
    }
    return Object.freeze(siblings);
  }
}

function scannedDirectories(stateDirectory: string): readonly string[] {
  return Object.freeze([stateDirectory, join(stateDirectory, dirname(CHECKPOINT_STATE_FILE))]);
}

function systemNow(): Date {
  return new Date();
}

function writeStartOutput(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Damaged content is set aside; typed private-filesystem failures are not ours to hide. */
function isRecoverableStateFailure(error: unknown): boolean {
  if (isPrivateFilesystemFailure(error)) return false;
  return error instanceof SyntaxError || error instanceof ZodError;
}

function isPrivateFilesystemFailure(error: unknown): boolean {
  return diagnosticCodeOf(error)?.startsWith("private-fs.") === true;
}

function diagnosticCodeOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = (error as Error & { readonly diagnosticCode?: unknown }).diagnosticCode;
  return typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) ? code : null;
}

/** Resolve the interface language the same way the entry point does, minus `--lang`. */
async function createStartupTranslator(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): Promise<Translator> {
  const configuredRoot = environment.MAREA_STATE_HOME?.trim() ?? "";
  const stateRoot = configuredRoot === "" ? join(homeDirectory, ".marea") : configuredRoot;
  const saved = await createStudentLanguagePreferenceStore(stateRoot).load();
  const resolution = resolveStudentLocale({
    commandLine: undefined,
    environment: environment.MAREA_LANG,
    saved,
    system: systemLocaleCandidates(environment),
  });
  return createTranslator(resolution.locale);
}
