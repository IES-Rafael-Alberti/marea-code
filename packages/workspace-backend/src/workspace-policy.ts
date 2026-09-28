import type { Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  WorkspaceError,
  type WorkspaceLimits,
  type WorkspaceOperation,
  type WorkspaceTextEdit,
} from "./contracts.js";
import { parseVirtualPath, type VirtualPath } from "./virtual-path.js";

const DEFAULT_LIMITS: WorkspaceLimits = {
  maxReadBytes: 1_048_576,
  maxWriteBytes: 1_048_576,
  maxDirectoryEntries: 10_000,
};
const MAXIMUM_FILE_LIMIT = 134_217_728;
const MAXIMUM_DIRECTORY_LIMIT = 100_000;

export interface MutableVirtualPath extends VirtualPath {
  readonly segments: readonly [string, ...string[]];
}

export function assertRoot(
  stat: Stats | undefined,
  operation: WorkspaceOperation,
): asserts stat is Stats {
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceError("invalid-root", operation);
  }
}

export function assertNotLink(stat: Stats, operation: WorkspaceOperation): void {
  if (stat.isSymbolicLink()) {
    throw new WorkspaceError("unsafe-entry", operation);
  }
}

export function assertDirectory(stat: Stats, operation: WorkspaceOperation): void {
  if (!stat.isDirectory()) {
    throw new WorkspaceError("not-directory", operation);
  }
}

export function assertRegularFile(stat: Stats, operation: WorkspaceOperation): void {
  if (!stat.isFile()) {
    throw new WorkspaceError("not-regular-file", operation);
  }
  if (stat.nlink !== 1) {
    throw new WorkspaceError("unsafe-entry", operation);
  }
}

export function assertSupportedEntry(stat: Stats, operation: WorkspaceOperation): void {
  if (stat.isDirectory()) {
    return;
  }
  assertRegularFile(stat, operation);
}

export function parseMutablePath(
  virtualPath: string,
  operation: WorkspaceOperation,
): MutableVirtualPath {
  const parsed = parseVirtualPath(virtualPath, operation);
  const [firstSegment, ...remainingSegments] = parsed.segments;
  if (firstSegment === undefined) {
    throw new WorkspaceError("invalid-path", operation);
  }
  return { value: parsed.value, segments: [firstSegment, ...remainingSegments] };
}

export function lastSegment(virtualPath: MutableVirtualPath): string {
  const [firstSegment, ...remainingSegments] = virtualPath.segments;
  return remainingSegments.reduce((_lastSegment, segment) => segment, firstSegment);
}

export function parseLimits(
  input: Partial<WorkspaceLimits> | undefined,
  operation: WorkspaceOperation,
): WorkspaceLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  assertLimit(limits.maxReadBytes, MAXIMUM_FILE_LIMIT, operation);
  assertLimit(limits.maxWriteBytes, MAXIMUM_FILE_LIMIT, operation);
  assertLimit(limits.maxDirectoryEntries, MAXIMUM_DIRECTORY_LIMIT, operation);
  return limits;
}

export function encodeBounded(
  content: string,
  maximumBytes: number,
  operation: WorkspaceOperation,
): Uint8Array {
  if (content.length > maximumBytes) {
    throw new WorkspaceError("write-limit-exceeded", operation);
  }
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength > maximumBytes) {
    throw new WorkspaceError("write-limit-exceeded", operation);
  }
  return encoded;
}

export function countOccurrences(content: string, expected: string): number {
  let count = 0;
  content.replaceAll(expected, () => {
    count += 1;
    return expected;
  });
  return count;
}

export function applyEdit(content: string, edit: WorkspaceTextEdit): string {
  return content.replaceAll(edit.expected, edit.replacement);
}

export function hasSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function hasSameSnapshot(left: Stats, right: Stats): boolean {
  return (
    hasSameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function isContained(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

export function isSamePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function assertLimit(value: number, maximum: number, operation: WorkspaceOperation): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new WorkspaceError("invalid-limit", operation);
  }
}
