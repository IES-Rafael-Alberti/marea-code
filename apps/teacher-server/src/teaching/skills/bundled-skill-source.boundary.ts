import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { BundledSkillError } from "./errors.js";
import { parseSkillFrontmatter } from "./frontmatter.boundary.js";
import { digestSkillFiles } from "./skill-digest.js";
import {
  bundledSkillId,
  isValidSkillName,
  summarizeSkill,
  type SkillBundle,
  type SkillFile,
  type SkillId,
  type SkillKind,
  type SkillSource,
  type SkillSummary,
} from "./skill-source.js";

export const MAX_BUNDLED_SKILL_FILE_BYTES = 512 * 1_024;

const TEXT_EXTENSIONS = new Set([".csv", ".json", ".md", ".txt", ".yaml", ".yml"]);
const SKILL_KINDS: readonly SkillKind[] = ["didactic", "evaluation"];
const UTF8_DECODER = new TextDecoder(undefined, { fatal: true });

export class BundledSkillSource implements SkillSource {
  readonly #rootDirectory: string;

  constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory);
  }

  async list(kind: SkillKind): Promise<readonly SkillSummary[]> {
    const bundles = await this.#readCatalog();
    return Object.freeze(bundles.filter((bundle) => bundle.kind === kind).map(summarizeSkill));
  }

  async load(id: SkillId): Promise<SkillBundle | null> {
    const bundles = await this.#readCatalog();
    return bundles.find((bundle) => bundle.id === id) ?? null;
  }

  async #readCatalog(): Promise<readonly SkillBundle[]> {
    const root = await checkedRoot(this.#rootDirectory);
    // Stryker disable next-line ArrayDeclaration: Its sentinel is not a SkillBundle and is rejected by TypeScript.
    const bundles: SkillBundle[] = [];
    const ids = new Set<SkillId>();

    for (const kind of SKILL_KINDS) {
      const kindDirectory = join(root, kind);
      await assertKindDirectory(kindDirectory, kind);
      const entries = await readDirectory(kindDirectory);
      for (const entry of entries) {
        const location = `${kind}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw skillError(
            "UNSAFE_SYMLINK",
            location,
            "Replace the skill link with a real directory.",
          );
        }
        if (!entry.isDirectory()) {
          throw skillError(
            "UNSUPPORTED_ENTRY_TYPE",
            location,
            "Keep only skill directories directly below each kind directory.",
          );
        }
        if (!isValidSkillName(entry.name)) {
          throw skillError(
            "INVALID_SKILL_NAME",
            location,
            "Rename the directory to a portable lowercase ASCII skill name.",
          );
        }
        const bundle = await readBundle(root, kind, entry.name);
        if (ids.has(bundle.id)) {
          throw skillError(
            "DUPLICATE_SKILL_ID",
            location,
            `Rename one skill; ${bundle.id} must identify exactly one bundled skill.`,
          );
        }
        ids.add(bundle.id);
        bundles.push(bundle);
      }
    }

    return Object.freeze(bundles);
  }
}

async function assertKindDirectory(kindDirectory: string, kind: SkillKind): Promise<void> {
  const stats = await readStats(kindDirectory);
  if (stats.isSymbolicLink()) {
    throw skillError(
      "UNSAFE_SYMLINK",
      kind,
      "Replace the kind link with a real directory under the bundled root.",
    );
  }
  if (!stats.isDirectory()) {
    throw skillError(
      "UNSUPPORTED_ENTRY_TYPE",
      kind,
      "Create a directory for this bundled skill kind.",
    );
  }
}

async function checkedRoot(rootDirectory: string): Promise<string> {
  const stats = await readStats(rootDirectory);
  if (stats.isSymbolicLink()) {
    throw skillError(
      "UNSAFE_SYMLINK",
      rootDirectory,
      "Configure the real content/skills directory instead of a symbolic link.",
    );
  }
  if (!stats.isDirectory()) {
    throw skillError(
      "ROOT_NOT_DIRECTORY",
      rootDirectory,
      "Configure an existing content/skills directory.",
    );
  }
  return readRealPath(rootDirectory);
}

async function readBundle(root: string, kind: SkillKind, name: string): Promise<SkillBundle> {
  const skillDirectory = join(root, kind, name);
  const files = await collectBundleFiles(root, skillDirectory);
  const skillFile = files.find((file) => file.path === "SKILL.md");
  const location = `${kind}/${name}/SKILL.md`;
  if (skillFile === undefined) {
    throw skillError(
      "MISSING_SKILL_FILE",
      location,
      "Add a regular SKILL.md file at the skill root.",
    );
  }
  const metadata = parseSkillFrontmatter(skillFile.content, name, kind, location);

  return Object.freeze({
    id: bundledSkillId(name),
    name,
    description: metadata.description,
    kind,
    source: "marea",
    digest: digestSkillFiles(files),
    license: metadata.license,
    compatibility: metadata.compatibility,
    criteria: metadata.criteria,
    files,
  });
}

async function collectBundleFiles(
  root: string,
  skillDirectory: string,
): Promise<readonly SkillFile[]> {
  await assertContained(root, skillDirectory);
  const entries = await readDirectory(skillDirectory);
  const files: SkillFile[] = [];

  for (const entry of entries) {
    const absolutePath = join(skillDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw skillError(
        "UNSAFE_SYMLINK",
        entry.name,
        "Replace the link with a regular SKILL.md file or resources directory.",
      );
    }
    if (entry.name === "SKILL.md") {
      files.push(await readTextFile(root, absolutePath, entry.name));
      continue;
    }
    if (entry.name === "resources") {
      if (!entry.isDirectory()) {
        throw skillError(
          "UNSUPPORTED_ENTRY_TYPE",
          entry.name,
          "Replace resources with a directory of text resources.",
        );
      }
      files.push(...(await collectFiles(root, absolutePath, entry.name)));
      continue;
    }
    throw skillError(
      "UNSUPPORTED_SKILL_LAYOUT",
      entry.name,
      "Keep only SKILL.md and an optional resources directory at the skill root.",
    );
  }

  return Object.freeze(files.sort(compareFiles));
}

async function collectFiles(
  root: string,
  directory: string,
  relativeDirectory: string,
): Promise<readonly SkillFile[]> {
  await assertContained(root, directory);
  const entries = await readDirectory(directory);
  const files: SkillFile[] = [];

  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    assertSafeSegment(entry.name, relativePath);
    const absolutePath = join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      throw skillError(
        "UNSAFE_SYMLINK",
        relativePath,
        "Replace the link with a regular file or directory inside the skill.",
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw skillError(
        "UNSUPPORTED_ENTRY_TYPE",
        relativePath,
        "Use only regular files and directories in bundled skills.",
      );
    }
    files.push(await readTextFile(root, absolutePath, relativePath));
  }

  return Object.freeze(files);
}

async function readTextFile(
  root: string,
  absolutePath: string,
  relativePath: string,
): Promise<SkillFile> {
  if (!TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    throw skillError(
      "UNSUPPORTED_FILE_TYPE",
      relativePath,
      "Use only .md, .txt, .yaml, .yml, .json, or .csv resources.",
    );
  }
  const stats = await readStats(absolutePath);
  if (stats.isSymbolicLink()) {
    throw skillError("UNSAFE_SYMLINK", relativePath, "Replace the link with a regular text file.");
  }
  if (!stats.isFile()) {
    throw skillError(
      "UNSUPPORTED_ENTRY_TYPE",
      relativePath,
      "Replace the entry with a regular text file.",
    );
  }
  if (stats.size > MAX_BUNDLED_SKILL_FILE_BYTES) {
    throw tooLarge(relativePath);
  }
  await assertContained(root, absolutePath);
  const bytes = await readBytes(absolutePath);
  if (bytes.byteLength > MAX_BUNDLED_SKILL_FILE_BYTES) {
    throw tooLarge(relativePath);
  }

  let content: string;
  try {
    content = UTF8_DECODER.decode(bytes);
  } catch {
    throw skillError("INVALID_TEXT_ENCODING", relativePath, "Save the file as valid UTF-8.");
  }
  if (content.includes("\0")) {
    throw skillError("INVALID_TEXT_ENCODING", relativePath, "Remove NUL bytes from the text file.");
  }
  return Object.freeze({ path: relativePath, content, sizeBytes: bytes.byteLength });
}

async function assertContained(root: string, target: string): Promise<void> {
  const resolvedTarget = await readRealPath(target);
  const pathFromRoot = relative(root, resolvedTarget);
  if (isPathOutsideRoot(pathFromRoot)) {
    throw skillError(
      "PATH_OUTSIDE_ROOT",
      target,
      "Move the entry inside the configured bundled skill root.",
    );
  }
}

export function isPathOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function assertSafeSegment(segment: string, location: string): void {
  if (segment.startsWith(".") || segment.includes("\\")) {
    throw skillError(
      "UNSAFE_PATH",
      location,
      "Use visible relative names without dot-prefixed segments or backslashes.",
    );
  }
}

async function readStats(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    throw readFailure(path, error);
  }
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.sort((left, right) => compareText(left.name, right.name));
  } catch (error: unknown) {
    throw readFailure(path, error);
  }
}

async function readRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    throw readFailure(path, error);
  }
}

async function readBytes(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    throw readFailure(path, error);
  }
}

function readFailure(path: string, error: unknown): BundledSkillError {
  const detail = String(error);
  return skillError(
    "READ_FAILED",
    path,
    `Check that the bundled content exists and is readable (${detail}).`,
  );
}

function tooLarge(location: string): BundledSkillError {
  return skillError(
    "FILE_TOO_LARGE",
    location,
    `Reduce the file below ${String(MAX_BUNDLED_SKILL_FILE_BYTES)} bytes.`,
  );
}

function skillError(
  code: ConstructorParameters<typeof BundledSkillError>[0],
  location: string,
  action: string,
): BundledSkillError {
  return new BundledSkillError(code, location, `${location}: ${action}`);
}

function compareFiles(left: SkillFile, right: SkillFile): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: Equal sort keys are indistinguishable in the resulting sequence, but Array.sort requires zero for comparator correctness.
  return left === right ? 0 : left < right ? -1 : 1;
}
