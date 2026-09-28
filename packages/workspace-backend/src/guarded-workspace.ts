import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  WorkspaceError,
  type GuardedWorkspaceOptions,
  type WorkspaceBackend,
  type WorkspaceEntry,
  type WorkspaceLimits,
  type WorkspaceOperation,
  type WorkspaceTextEdit,
  type WorkspaceWriteOptions,
} from "./contracts.js";
import {
  decodeUtf8,
  inspectPath,
  movePath,
  readBoundedFile,
  readNames,
  removeEmptyDirectory,
  removeRegularFile,
  removeTemporaryFile,
  resolveRealPath,
  writeExclusiveFile,
} from "./filesystem.boundary.js";
import { appendVirtualPath, parseVirtualPath, type VirtualPath } from "./virtual-path.js";
import { MutationQueue } from "./mutation-queue.js";
import {
  applyEdit,
  assertDirectory,
  assertRegularFile,
  assertRoot,
  assertSupportedEntry,
  countOccurrences,
  encodeBounded,
  lastSegment,
  parseLimits,
  parseMutablePath,
} from "./workspace-policy.js";
import { WorkspaceResolver, type LocatedParent } from "./workspace-resolver.js";

class LocalGuardedWorkspace implements WorkspaceBackend {
  private readonly mutations = new MutationQueue();

  private constructor(
    private readonly resolver: WorkspaceResolver,
    private readonly limits: WorkspaceLimits,
  ) {}

  static async open(options: GuardedWorkspaceOptions): Promise<LocalGuardedWorkspace> {
    const operation = "initialize";
    if (options.rootPath.trim().length === 0 || options.rootPath.includes("\0")) {
      throw new WorkspaceError("invalid-root", operation);
    }

    const requestedRoot = resolve(options.rootPath);
    const requestedStat = await inspectPath(requestedRoot, operation);
    assertRoot(requestedStat, operation);
    const canonicalRoot = await resolveRealPath(requestedRoot, operation);
    const canonicalStat = await inspectPath(canonicalRoot, operation);
    assertRoot(canonicalStat, operation);
    const limits = parseLimits(options.limits, operation);
    return new LocalGuardedWorkspace(new WorkspaceResolver(canonicalRoot, canonicalStat), limits);
  }

  async readText(virtualPath: string): Promise<string> {
    const operation = "read";
    const parsed = parseVirtualPath(virtualPath, operation);
    const located = await this.resolver.locateExisting(parsed, operation);
    assertRegularFile(located.stat, operation);
    const content = await readBoundedFile(
      located.hostPath,
      operation,
      this.limits.maxReadBytes,
      located.stat,
    );
    return decodeUtf8(content, operation);
  }

  async writeText(
    virtualPath: string,
    content: string,
    options: WorkspaceWriteOptions = {},
  ): Promise<void> {
    return this.mutations.run(() => this.writeTextMutation(virtualPath, content, options));
  }

  private async writeTextMutation(
    virtualPath: string,
    content: string,
    options: WorkspaceWriteOptions,
  ): Promise<void> {
    const operation = "write";
    const parsed = parseMutablePath(virtualPath, operation);
    const bytes = encodeBounded(content, this.limits.maxWriteBytes, operation);
    const parent = await this.resolver.locateParent(
      parsed,
      operation,
      options.createParents === true,
    );
    const targetPath = join(parent.hostPath, lastSegment(parsed));
    const existing = await inspectPath(targetPath, operation);
    if (existing !== undefined) {
      await this.resolver.assertPhysicalEntry(targetPath, existing, operation);
      assertRegularFile(existing, operation);
    }
    await this.replaceAtomically(targetPath, parent, bytes, existing?.mode ?? 0o600, operation);
  }

  async editText(virtualPath: string, edit: WorkspaceTextEdit): Promise<number> {
    return this.mutations.run(() => this.editTextMutation(virtualPath, edit));
  }

  private async editTextMutation(virtualPath: string, edit: WorkspaceTextEdit): Promise<number> {
    const operation = "edit";
    const parsed = parseMutablePath(virtualPath, operation);
    if (edit.expected.length === 0) {
      throw new WorkspaceError("edit-conflict", operation);
    }
    const located = await this.resolver.locateExisting(parsed, operation);
    assertRegularFile(located.stat, operation);
    const original = decodeUtf8(
      await readBoundedFile(located.hostPath, operation, this.limits.maxReadBytes, located.stat),
      operation,
    );
    const occurrences = countOccurrences(original, edit.expected);
    if (occurrences === 0) {
      throw new WorkspaceError("edit-conflict", operation);
    }
    if (edit.occurrence !== "all" && occurrences > 1) {
      throw new WorkspaceError("edit-conflict", operation);
    }
    const updated = applyEdit(original, edit);
    const bytes = encodeBounded(updated, this.limits.maxWriteBytes, operation);
    const parent = await this.resolver.locateParent(parsed, operation, false);
    await this.resolver.assertEntryUnchanged(located, operation);
    await this.replaceAtomically(located.hostPath, parent, bytes, located.stat.mode, operation);
    return occurrences;
  }

  async list(virtualPath: string): Promise<readonly WorkspaceEntry[]> {
    const operation = "list";
    const parsed = parseVirtualPath(virtualPath, operation);
    const directory = await this.resolver.locateExisting(parsed, operation);
    assertDirectory(directory.stat, operation);
    const names = await readNames(directory.hostPath, operation);
    if (names.length > this.limits.maxDirectoryEntries) {
      throw new WorkspaceError("directory-limit-exceeded", operation);
    }
    const entries: WorkspaceEntry[] = [];
    for (const name of names) {
      entries.push(await this.describeEntry(parsed, directory.hostPath, name, operation));
    }
    return entries.toSorted((left, right) => left.path.localeCompare(right.path));
  }

  async deleteEntry(virtualPath: string): Promise<void> {
    return this.mutations.run(() => this.deleteEntryMutation(virtualPath));
  }

  private async deleteEntryMutation(virtualPath: string): Promise<void> {
    const operation = "delete";
    const parsed = parseMutablePath(virtualPath, operation);
    const located = await this.resolver.locateExisting(parsed, operation);
    if (located.stat.isFile()) {
      assertRegularFile(located.stat, operation);
      await this.resolver.assertEntryUnchanged(located, operation, "unsafe-entry");
      await removeRegularFile(located.hostPath, operation);
      return;
    }
    assertDirectory(located.stat, operation);
    await this.resolver.assertEntryUnchanged(located, operation, "unsafe-entry");
    await removeEmptyDirectory(located.hostPath, operation);
  }

  async renameEntry(sourcePath: string, destinationPath: string): Promise<void> {
    return this.mutations.run(() => this.renameEntryMutation(sourcePath, destinationPath));
  }

  private async renameEntryMutation(sourcePath: string, destinationPath: string): Promise<void> {
    const operation = "rename";
    const source = parseMutablePath(sourcePath, operation);
    const destination = parseMutablePath(destinationPath, operation);
    const locatedSource = await this.resolver.locateExisting(source, operation);
    assertSupportedEntry(locatedSource.stat, operation);
    const destinationParent = await this.resolver.locateParent(destination, operation, false);
    const destinationHostPath = join(destinationParent.hostPath, lastSegment(destination));
    if ((await inspectPath(destinationHostPath, operation)) !== undefined) {
      throw new WorkspaceError("already-exists", operation);
    }
    await this.resolver.assertEntryUnchanged(locatedSource, operation, "unsafe-entry");
    await this.resolver.assertDirectoryUnchanged(destinationParent, operation);
    await movePath(locatedSource.hostPath, destinationHostPath, operation);
  }

  private async describeEntry(
    parent: VirtualPath,
    parentHostPath: string,
    name: string,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceEntry> {
    const virtualPath = appendVirtualPath(parent, name);
    const hostPath = join(parentHostPath, name);
    const stat = await inspectPath(hostPath, operation);
    if (stat === undefined) {
      throw new WorkspaceError("not-found", operation);
    }
    await this.resolver.assertPhysicalEntry(hostPath, stat, operation);
    assertSupportedEntry(stat, operation);
    return {
      path: virtualPath.value,
      kind: stat.isDirectory() ? "directory" : "file",
      size: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  private async replaceAtomically(
    targetPath: string,
    parent: LocatedParent,
    content: Uint8Array,
    mode: number,
    operation: WorkspaceOperation,
  ): Promise<void> {
    await this.resolver.assertDirectoryUnchanged(parent, operation);
    const temporaryPath = join(parent.hostPath, `.marea-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    let committed = false;
    try {
      await writeExclusiveFile(temporaryPath, operation, content, mode & 0o777);
      temporaryCreated = true;
      await this.resolver.assertDirectoryUnchanged(parent, operation);
      await movePath(temporaryPath, targetPath, operation);
      committed = true;
    } finally {
      if (temporaryCreated && !committed) {
        await removeTemporaryFile(temporaryPath);
      }
    }
  }
}

export function openGuardedWorkspace(options: GuardedWorkspaceOptions): Promise<WorkspaceBackend> {
  return LocalGuardedWorkspace.open(options);
}
