import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";

import { SkillIdSchema } from "@marea/protocol";

import {
  assertCrossKindSlugAvailable,
  decodeText,
  isSkillKindName,
  validateAuthoringFiles,
  validateKind,
  validateSlug,
  validateOwnerIdentity,
  validateSaveRequest,
  withOwnerProvenance,
  type SkillAuthoringFile,
  type SkillOwnerIdentity,
  type SkillSaveRequest,
  type SkillSaveRequestSnapshot,
} from "./authoring-validation.boundary.js";
import { SkillAuthoringError, type SkillAuthoringErrorCode } from "./errors.js";
import {
  assertTransactionContents,
  bundledSkillId,
  readEntries,
  committedLinkError,
  createConflictError,
  journalLinkError,
  kindLinkError,
  requireSkillBundle,
  staleDigestError,
  transactionLinkError,
} from "./skill-authoring-helpers.boundary.js";
import { isValidSkillName } from "../skills/skill-source.js";
import { withOwnerGate } from "./owner-gate.js";
import { canonicalOwnerRoot, isMissingOwnerPath } from "./skill-owner-root.boundary.js";
import { BundledSkillSource } from "../skills/bundled-skill-source.boundary.js";
import { DirectorySkillSource } from "../skills/directory-skill-source.boundary.js";
import type { SkillBundle, SkillKind, SkillSummary, SkillSource } from "../skills/skill-source.js";

const TRANSACTIONS = ".authoring-transactions";
const JOURNAL = "journal";
const WRITE_FAILED: SkillAuthoringErrorCode = "AUTHORING_WRITE_FAILED";
const RECOVERY_FAILED: SkillAuthoringErrorCode = "AUTHORING_RECOVERY_FAILED";
const ROOT_EXCLUSIVE: SkillAuthoringErrorCode = "ROOT_NOT_EXCLUSIVE";

/** Trusted host authorization checked after staging and immediately before publish. */
export type SkillAuthoringPublicationGuard = () => void | Promise<void>;

export type {
  SkillAuthoringFile,
  SkillOwnerIdentity,
  SkillSaveRequest,
  SkillSaveRequestSnapshot,
} from "./authoring-validation.boundary.js";

export class SkillAuthoringStore {
  readonly #root: string;
  readonly #owner: SkillOwnerIdentity;
  readonly #reader: DirectorySkillSource;

  constructor(rootDirectory: string, owner: SkillOwnerIdentity) {
    this.#owner = validateOwnerIdentity(owner);
    this.#root = canonicalOwnerRoot(resolve(rootDirectory));
    this.#reader = new DirectorySkillSource(this.#root, this.#owner);
  }

  /** Private ordering key for multi-owner read/publication coordination. */
  get coordinationKey(): string {
    return this.#root;
  }

  /** Holds the same gate as writes through the caller's final SQL publication.
   * The supplied reader must not escape this callback or be used after it settles.
   */
  withReadSource<T>(operation: (source: SkillSource) => Promise<T>): Promise<T> {
    return this.#run(async () => {
      await this.#recover();
      return operation(this.#reader);
    });
  }

  /** Creates the two fixed kind roots before first read. */
  async initialize(): Promise<void> {
    return this.#run(async () => {
      await this.#recover();
      for (const kind of ["didactic", "evaluation"] as const) {
        const kindPath = join(this.#root, kind);
        const stats = await readStats(kindPath, WRITE_FAILED);
        if (stats === undefined) {
          await this.#mkdir(kindPath);
          continue;
        }
        if (stats.isSymbolicLink()) {
          throw kindLinkError(kind);
        }
        if (!stats.isDirectory()) {
          throw new SkillAuthoringError(
            ROOT_EXCLUSIVE,
            kind,
            "Use a directory for this skill kind.",
          );
        }
      }
    });
  }

  async list(kind: SkillKind): Promise<readonly SkillSummary[]> {
    const validatedKind = validateKind(kind);
    return this.#run(async () => {
      await this.#recover();
      return this.#reader.list(validatedKind);
    });
  }

  async read(id: string): Promise<SkillBundle | null> {
    const skillId = SkillIdSchema.parse(decodeText(id, "skill-id"));
    return this.#run(async () => {
      await this.#recover();
      return this.#reader.load(skillId);
    });
  }

  async validate(
    kind: SkillKind,
    slug: string,
    files: readonly SkillAuthoringFile[],
  ): Promise<SkillBundle | null> {
    const validatedKind = validateKind(kind);
    const validatedSlug = validateSlug(slug);
    const canonical = validateAuthoringFiles(validatedKind, validatedSlug, files);
    return this.#run(async () => {
      await this.#recover();
      const transactionDirectory = this.#transactionDirectory(validatedKind, validatedSlug);
      try {
        await this.#prepareStage(transactionDirectory, validatedKind, validatedSlug, canonical);
        const staged = await requireSkillBundle(
          new BundledSkillSource(transactionDirectory),
          bundledSkillId(validatedSlug),
        );
        return withOwnerProvenance(staged, this.#owner);
      } finally {
        await this.#recoverTarget(validatedKind, validatedSlug);
      }
    });
  }

  async create(
    request: SkillSaveRequest,
    beforePublish?: SkillAuthoringPublicationGuard,
  ): Promise<SkillBundle> {
    const snapshot = validateSaveRequest(request);
    if (snapshot.expectedDigest !== null) {
      throw new SkillAuthoringError(
        "UNSAFE_AUTHORING_INPUT",
        `${snapshot.kind}/${snapshot.slug}`,
        "Create accepts only a null expected digest.",
      );
    }
    return this.#run(() => this.#save(snapshot, false, beforePublish));
  }

  async replace(
    request: SkillSaveRequest,
    beforePublish?: SkillAuthoringPublicationGuard,
  ): Promise<SkillBundle> {
    const snapshot = validateSaveRequest(request);
    return this.#run(() => this.#save(snapshot, true, beforePublish));
  }

  recover(): Promise<void> {
    return this.#run(() => this.#recover());
  }

  async #save(
    snapshot: SkillSaveRequestSnapshot,
    replacing: boolean,
    beforePublish?: SkillAuthoringPublicationGuard,
  ): Promise<SkillBundle> {
    await this.#recover();
    const { kind, slug } = snapshot;
    await this.#assertKindDirectory(kind);
    const location = `${kind}/${slug}`;
    const committed = join(this.#root, kind, slug);
    const stats = await readStats(committed, WRITE_FAILED);
    if (stats !== undefined) {
      if (stats.isSymbolicLink()) {
        throw committedLinkError(location);
      }
      if (!stats.isDirectory()) {
        throw new SkillAuthoringError(
          WRITE_FAILED,
          committed,
          "Use a real skill directory for each committed skill.",
        );
      }
    }
    const current = stats === undefined ? null : await this.#committedBundle(slug);
    if (current !== null) {
      if (replacing) {
        if (current.digest !== snapshot.expectedDigest) {
          throw staleDigestError(location);
        }
      } else {
        throw createConflictError(location, slug);
      }
    } else if (replacing) {
      throw new SkillAuthoringError(
        "STALE_SKILL_DIGEST",
        location,
        "Provide the digest of an existing skill before replacing it.",
      );
    }
    await this.#assertCrossKind(kind, slug);
    const transactionDirectory = this.#transactionDirectory(kind, slug);
    try {
      await this.#prepareStage(transactionDirectory, kind, slug, snapshot.files);
      await requireSkillBundle(new BundledSkillSource(transactionDirectory), bundledSkillId(slug));
      await beforePublish?.();
      await this.#publish(transactionDirectory, kind, slug, replacing);
    } finally {
      await this.#recoverTarget(kind, slug);
    }
    return await this.#committedBundle(slug);
  }

  async #prepareStage(
    stageRoot: string,
    kind: SkillKind,
    slug: string,
    files: readonly SkillAuthoringFile[],
  ): Promise<void> {
    for (const transactionKind of ["didactic", "evaluation"] as const) {
      await this.#mkdir(join(stageRoot, transactionKind));
    }
    const skillDirectory = join(stageRoot, kind, slug);
    for (const file of files) {
      const destination = join(skillDirectory, file.path);
      await this.#mkdir(dirname(destination));
      await this.#write(destination, file.content);
    }
  }

  async #publish(
    transactionDirectory: string,
    kind: SkillKind,
    slug: string,
    replacing: boolean,
  ): Promise<void> {
    if (replacing) {
      await this.#rename(join(this.#root, kind, slug), join(transactionDirectory, JOURNAL));
    }
    await this.#rename(join(transactionDirectory, kind, slug), join(this.#root, kind, slug));
  }

  async #recover(): Promise<void> {
    const transactions = join(this.#root, TRANSACTIONS);
    const transactionsStats = await readStats(transactions, RECOVERY_FAILED);
    if (transactionsStats === undefined) return;
    if (transactionsStats.isSymbolicLink()) {
      throw new SkillAuthoringError(
        RECOVERY_FAILED,
        transactions,
        "Use a real transaction root directory instead of a symbolic link.",
      );
    }
    if (!transactionsStats.isDirectory()) {
      throw new SkillAuthoringError(
        RECOVERY_FAILED,
        transactions,
        "Inspect the transaction root; it must be a real directory.",
      );
    }
    for (const kindEntry of await readEntries(transactions)) {
      if (kindEntry.isSymbolicLink()) {
        throw transactionLinkError(kindEntry.name);
      }
      if (!kindEntry.isDirectory()) continue;
      if (!isSkillKindName(kindEntry.name)) {
        throw new SkillAuthoringError(
          RECOVERY_FAILED,
          kindEntry.name,
          "Inspect the unknown transaction directory before any cleanup.",
        );
      }
      for (const slugEntry of await readEntries(join(transactions, kindEntry.name))) {
        if (slugEntry.isSymbolicLink()) {
          throw transactionLinkError(`${kindEntry.name}/${slugEntry.name}`);
        }
        if (!slugEntry.isDirectory()) continue;
        await this.#recoverTarget(kindEntry.name, transactionSlug(slugEntry.name));
      }
    }
  }

  async #recoverTarget(kind: SkillKind, slug: string): Promise<void> {
    const location = `${kind}/${slug}`;
    const transactionDirectory = this.#transactionDirectory(kind, slug);
    if ((await readStats(transactionDirectory, RECOVERY_FAILED)) === undefined) return;
    const journal = join(transactionDirectory, JOURNAL);
    const journalStats = await readStats(journal, RECOVERY_FAILED);
    if (journalStats?.isSymbolicLink()) {
      throw journalLinkError(location);
    }
    await this.#assertKindDirectory(kind);
    const committed = join(this.#root, kind, slug);
    const committedStats = await readStats(committed, RECOVERY_FAILED);
    if (committedStats?.isSymbolicLink()) {
      throw committedLinkError(location);
    }
    if (committedStats !== undefined && !committedStats.isDirectory()) {
      throw new SkillAuthoringError(
        RECOVERY_FAILED,
        committed,
        "Inspect the committed skill path; it must be a real directory.",
      );
    }
    if (journalStats !== undefined && !journalStats.isDirectory()) {
      throw new SkillAuthoringError(
        RECOVERY_FAILED,
        journal,
        "Inspect the transaction journal; it must be a real directory.",
      );
    }
    await assertTransactionContents(transactionDirectory, location);
    if (journalStats === undefined) {
      await this.#remove(transactionDirectory);
      return;
    }
    if (committedStats !== undefined) {
      await this.#remove(journal);
      await this.#remove(transactionDirectory);
      return;
    }
    await this.#rename(journal, committed);
    await this.#remove(transactionDirectory);
  }

  async #assertKindDirectory(kind: SkillKind): Promise<void> {
    const stats = await readStats(join(this.#root, kind), WRITE_FAILED);
    if (stats === undefined) {
      throw new SkillAuthoringError(
        WRITE_FAILED,
        kind,
        "Create the skill kind directory before saving.",
      );
    }
    if (stats.isSymbolicLink()) {
      throw kindLinkError(kind);
    }
  }

  async #assertCrossKind(kind: SkillKind, slug: string): Promise<void> {
    const other = kind === "didactic" ? "evaluation" : "didactic";
    const otherStats = await readStats(join(this.#root, other, slug), WRITE_FAILED);
    assertCrossKindSlugAvailable(kind, slug, other, otherStats !== undefined);
  }

  async #committedBundle(slug: string): Promise<SkillBundle> {
    return requireSkillBundle(
      this.#reader,
      SkillIdSchema.parse(`${this.#owner.source}/${this.#owner.id}/${slug}`),
    );
  }

  #transactionDirectory(kind: string, slug: string): string {
    return join(this.#root, TRANSACTIONS, kind, slug);
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    return withOwnerGate(this.#root, async () => {
      await this.#ensureRootDirectory();
      return operation();
    });
  }

  async #ensureRootDirectory(): Promise<void> {
    const stats = await readStats(this.#root, ROOT_EXCLUSIVE);
    if (stats === undefined) {
      await this.#mkdir(this.#root);
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new SkillAuthoringError(
        ROOT_EXCLUSIVE,
        this.#root,
        "Use a real exclusive owner skill root directory instead of a symbolic link.",
      );
    }
    if (!stats.isDirectory()) {
      throw new SkillAuthoringError(
        ROOT_EXCLUSIVE,
        this.#root,
        "Use a real exclusive owner skill root directory.",
      );
    }
  }

  async #mkdir(path: string): Promise<void> {
    try {
      await mkdir(path, { recursive: true });
    } catch {
      throw writeFailure(path);
    }
  }

  async #write(path: string, content: string): Promise<void> {
    try {
      await writeFile(path, UTF8.encode(content));
    } catch {
      throw writeFailure(path);
    }
  }

  async #rename(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch {
      throw writeFailure(from);
    }
  }

  async #remove(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true });
    } catch {
      throw writeFailure(path);
    }
  }
}

const UTF8 = new TextEncoder();

function transactionSlug(value: string): string {
  if (!isValidSkillName(value)) {
    throw new SkillAuthoringError(
      RECOVERY_FAILED,
      value,
      "Inspect the invalid transaction name before any cleanup.",
    );
  }
  return value;
}

async function readStats(
  path: string,
  code: SkillAuthoringErrorCode,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isMissingOwnerPath(error)) return undefined;
    throw new SkillAuthoringError(
      code,
      path,
      "The exclusive filesystem could not inspect the skill state.",
    );
  }
}

function writeFailure(location: string): SkillAuthoringError {
  return new SkillAuthoringError(
    WRITE_FAILED,
    location,
    "The exclusive filesystem did not accept the bounded write operation.",
  );
}
