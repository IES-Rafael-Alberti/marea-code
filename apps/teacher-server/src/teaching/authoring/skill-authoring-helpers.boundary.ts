import { SkillIdSchema } from "@marea/protocol";

import { isSkillFilePath } from "@marea/protocol";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { isSkillKindName } from "./authoring-validation.boundary.js";
import { SkillAuthoringError, type SkillAuthoringErrorCode } from "./errors.js";
import type { SkillBundle, SkillId, SkillKind, SkillSource } from "../skills/skill-source.js";

const JOURNAL = "journal";
const RECOVERY_FAILED: SkillAuthoringErrorCode = "AUTHORING_RECOVERY_FAILED";
const CC_PATTERN = /\p{Cc}/u;

function isSafeResourceName(name: string): boolean {
  return !name.startsWith(".") && !name.includes("\\") && !CC_PATTERN.test(name);
}

export async function readEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    throw new SkillAuthoringError(
      RECOVERY_FAILED,
      path,
      "The exclusive filesystem could not inspect the skill state.",
    );
  }
}

export function bundledSkillId(slug: string): SkillId {
  return SkillIdSchema.parse(`marea/${slug}`);
}

export function kindLinkError(kind: SkillKind): SkillAuthoringError {
  return new SkillAuthoringError(
    "UNSAFE_SYMLINK",
    kind,
    "Use a real kind directory instead of a symbolic link.",
  );
}

export function committedLinkError(location: string): SkillAuthoringError {
  return new SkillAuthoringError(
    "UNSAFE_SYMLINK",
    location,
    "Replace the committed skill link with a real directory.",
  );
}

export function journalLinkError(location: string): SkillAuthoringError {
  return new SkillAuthoringError(
    "UNSAFE_SYMLINK",
    location,
    "Replace the transaction journal with a real directory.",
  );
}

export function transactionLinkError(location: string): SkillAuthoringError {
  return new SkillAuthoringError(
    RECOVERY_FAILED,
    location,
    "Inspect the transaction state; a symbolic link cannot be recovered.",
  );
}

function unknownTransactionError(location: string): SkillAuthoringError {
  return new SkillAuthoringError(
    RECOVERY_FAILED,
    location,
    "Inspect the unknown transaction contents before any cleanup.",
  );
}

export function staleDigestError(location: string): SkillAuthoringError {
  return new SkillAuthoringError(
    "STALE_SKILL_DIGEST",
    location,
    "Refresh the saved skill digest before writing.",
  );
}

export function createConflictError(location: string, slug: string): SkillAuthoringError {
  return new SkillAuthoringError(
    "SKILL_EXISTS",
    location,
    `Another committed skill already uses slug '${slug}'.`,
  );
}

export async function assertTransactionContents(
  transactionDirectory: string,
  location: string,
): Promise<void> {
  let journalFound = false;
  for (const entry of await readEntries(transactionDirectory)) {
    const entryLocation = `${location}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw transactionLinkError(entryLocation);
    }
    if (entry.name === JOURNAL) {
      journalFound = true;
      continue;
    }
    if (entry.isDirectory() && isSkillKindName(entry.name)) {
      await assertStageKindDirectory(join(transactionDirectory, entry.name), entryLocation);
      continue;
    }
    throw unknownTransactionError(entryLocation);
  }
  if (journalFound) {
    await assertSkillLayout(join(transactionDirectory, JOURNAL), location);
  }
}

async function assertStageKindDirectory(kindDirectory: string, location: string): Promise<void> {
  for (const slugEntry of await readEntries(kindDirectory)) {
    const slugLocation = `${location}/${slugEntry.name}`;
    if (slugEntry.isSymbolicLink()) {
      throw transactionLinkError(slugLocation);
    }
    if (!slugEntry.isDirectory()) {
      throw unknownTransactionError(slugLocation);
    }
    await assertSkillLayout(join(kindDirectory, slugEntry.name), slugLocation);
  }
}

async function assertSkillLayout(directory: string, location: string): Promise<void> {
  for (const entry of await readEntries(directory)) {
    const entryLocation = `${location}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw transactionLinkError(entryLocation);
    }
    if (entry.name === "SKILL.md") {
      if (!entry.isFile()) {
        throw unknownTransactionError(entryLocation);
      }
      continue;
    }
    if (entry.name === "resources") {
      if (!entry.isDirectory()) {
        throw unknownTransactionError(entryLocation);
      }
      await assertResourceLayout(join(directory, entry.name), location, entry.name);
      continue;
    }
    throw unknownTransactionError(entryLocation);
  }
}

async function assertResourceLayout(
  directory: string,
  location: string,
  relativeBase: string,
): Promise<void> {
  for (const entry of await readEntries(directory)) {
    const relative = `${relativeBase}/${entry.name}`;
    const entryLocation = `${location}/${relative}`;
    if (entry.isSymbolicLink()) {
      throw transactionLinkError(entryLocation);
    }
    if (entry.isDirectory()) {
      if (!isSafeResourceName(entry.name)) {
        throw unknownTransactionError(entryLocation);
      }
      await assertResourceLayout(join(directory, entry.name), location, relative);
      continue;
    }
    if (entry.isFile() && isSkillFilePath(relative)) {
      continue;
    }
    throw unknownTransactionError(entryLocation);
  }
}

export async function requireSkillBundle(source: SkillSource, id: SkillId): Promise<SkillBundle> {
  const bundle = await source.load(id);
  if (bundle === null) {
    throw new SkillAuthoringError(
      "SKILL_MISSING",
      id,
      "The expected committed skill bundle is missing from its owner catalog.",
    );
  }
  return bundle;
}
