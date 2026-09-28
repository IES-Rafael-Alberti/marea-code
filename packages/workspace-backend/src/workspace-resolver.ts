import type { Stats } from "node:fs";
import { join } from "node:path";

import { WorkspaceError, type WorkspaceErrorCode, type WorkspaceOperation } from "./contracts.js";
import { createDirectory, inspectPath, resolveRealPath } from "./filesystem.boundary.js";
import type { VirtualPath } from "./virtual-path.js";
import {
  assertDirectory,
  assertNotLink,
  hasSameIdentity,
  hasSameSnapshot,
  isContained,
  isSamePath,
} from "./workspace-policy.js";

export interface LocatedEntry {
  readonly hostPath: string;
  readonly stat: Stats;
}

export interface LocatedParent {
  readonly hostPath: string;
  readonly stat: Stats;
}

export class WorkspaceResolver {
  constructor(
    private readonly rootPath: string,
    private readonly rootIdentity: Stats,
  ) {}

  async locateExisting(
    virtualPath: VirtualPath,
    operation: WorkspaceOperation,
  ): Promise<LocatedEntry> {
    await this.assertRootUnchanged(operation);
    let currentPath = this.rootPath;
    let currentStat = this.rootIdentity;
    const finalIndex = virtualPath.segments.length - 1;
    for (const [index, segment] of virtualPath.segments.entries()) {
      currentPath = join(currentPath, segment);
      const nextStat = await inspectPath(currentPath, operation);
      if (nextStat === undefined) {
        throw new WorkspaceError("not-found", operation);
      }
      await this.assertPhysicalEntry(currentPath, nextStat, operation);
      if (index !== finalIndex) {
        assertDirectory(nextStat, operation);
      }
      currentStat = nextStat;
    }
    return { hostPath: currentPath, stat: currentStat };
  }

  async locateParent(
    virtualPath: VirtualPath,
    operation: WorkspaceOperation,
    createParents: boolean,
  ): Promise<LocatedParent> {
    await this.assertRootUnchanged(operation);
    let currentPath = this.rootPath;
    let currentStat = this.rootIdentity;
    for (const segment of virtualPath.segments.slice(0, -1)) {
      currentPath = join(currentPath, segment);
      let nextStat = await inspectPath(currentPath, operation);
      if (nextStat === undefined && createParents) {
        await createDirectory(currentPath, operation);
        nextStat = await inspectPath(currentPath, operation);
      }
      if (nextStat === undefined) {
        throw new WorkspaceError("not-found", operation);
      }
      await this.assertPhysicalEntry(currentPath, nextStat, operation);
      assertDirectory(nextStat, operation);
      currentStat = nextStat;
    }
    return { hostPath: currentPath, stat: currentStat };
  }

  async assertPhysicalEntry(
    hostPath: string,
    stat: Stats,
    operation: WorkspaceOperation,
  ): Promise<void> {
    assertNotLink(stat, operation);
    const realPath = await resolveRealPath(hostPath, operation);
    if (!isContained(this.rootPath, realPath)) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
  }

  async assertEntryUnchanged(
    entry: LocatedEntry,
    operation: WorkspaceOperation,
    failureCode: Extract<WorkspaceErrorCode, "edit-conflict" | "unsafe-entry"> = "edit-conflict",
  ): Promise<void> {
    const current = await inspectPath(entry.hostPath, operation);
    if (current === undefined) {
      throw new WorkspaceError(failureCode, operation);
    }
    if (!hasSameSnapshot(current, entry.stat)) {
      throw new WorkspaceError(failureCode, operation);
    }
    await this.assertPhysicalEntry(entry.hostPath, current, operation);
  }

  async assertDirectoryUnchanged(
    directory: LocatedParent,
    operation: WorkspaceOperation,
  ): Promise<void> {
    const current = await inspectPath(directory.hostPath, operation);
    if (current === undefined) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    if (!hasSameIdentity(current, directory.stat)) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    if (!current.isDirectory()) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    await this.assertPhysicalEntry(directory.hostPath, current, operation);
  }

  private async assertRootUnchanged(operation: WorkspaceOperation): Promise<void> {
    const current = await inspectPath(this.rootPath, operation);
    if (current === undefined) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    if (current.isSymbolicLink()) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    if (!current.isDirectory()) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    if (!hasSameIdentity(current, this.rootIdentity)) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
    const realPath = await resolveRealPath(this.rootPath, operation);
    if (!isSamePath(realPath, this.rootPath)) {
      throw new WorkspaceError("unsafe-entry", operation);
    }
  }
}
