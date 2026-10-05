import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { WorkspaceError, type WorkspaceOperation } from "./contracts.js";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export async function inspectPath(
  hostPath: string,
  operation: WorkspaceOperation,
): Promise<Stats | undefined> {
  try {
    return await lstat(hostPath);
  } catch (cause: unknown) {
    if (hasErrorCode(cause, "ENOENT")) {
      return undefined;
    }
    throw mapFilesystemError(cause, operation);
  }
}

export function resolveRealPath(hostPath: string, operation: WorkspaceOperation): Promise<string> {
  return callFilesystem(operation, () => realpath(hostPath));
}

export function readNames(hostPath: string, operation: WorkspaceOperation): Promise<string[]> {
  return callFilesystem(operation, () => readdir(hostPath));
}

export function createDirectory(hostPath: string, operation: WorkspaceOperation): Promise<void> {
  return callFilesystem(operation, async () => {
    await mkdir(hostPath, { mode: 0o700 });
  });
}

export function removeRegularFile(hostPath: string, operation: WorkspaceOperation): Promise<void> {
  return callFilesystem(operation, () => unlink(hostPath));
}

export function removeEmptyDirectory(
  hostPath: string,
  operation: WorkspaceOperation,
): Promise<void> {
  return callFilesystem(operation, () => rmdir(hostPath));
}

export function movePath(
  sourcePath: string,
  destinationPath: string,
  operation: WorkspaceOperation,
): Promise<void> {
  return callFilesystem(operation, () => rename(sourcePath, destinationPath));
}

export async function readBoundedFile(
  hostPath: string,
  operation: WorkspaceOperation,
  maximumBytes: number,
  expected: Stats,
): Promise<Uint8Array> {
  return callFilesystem(operation, async () => {
    const handle = await open(hostPath, READ_FLAGS);
    try {
      const current = await handle.stat();
      assertOpenedFile(current, expected, operation);
      if (current.size > maximumBytes) {
        throw new WorkspaceError("read-limit-exceeded", operation);
      }

      const chunks: Uint8Array[] = [];
      let bytesRead = 0;
      const stream = handle.createReadStream({ autoClose: false, end: maximumBytes, start: 0 });
      for await (const boundaryChunk of stream) {
        const chunk = parseBinaryChunk(boundaryChunk, operation);
        bytesRead += chunk.byteLength;
        if (bytesRead > maximumBytes) {
          throw new WorkspaceError("read-limit-exceeded", operation);
        }
        chunks.push(chunk);
      }
      return Uint8Array.from(Buffer.concat(chunks, bytesRead));
    } finally {
      await handle.close();
    }
  });
}

export async function writeExclusiveFile(
  hostPath: string,
  operation: WorkspaceOperation,
  content: Uint8Array,
  mode: number,
): Promise<void> {
  const handle = await callFilesystem(operation, () => open(hostPath, WRITE_FLAGS, mode));
  try {
    await callFilesystem(operation, async () => {
      try {
        await handle.writeFile(content);
        // Creation applies umask; replacement must preserve the requested permission bits.
        await handle.chmod(mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  } catch (cause: unknown) {
    await removeTemporaryFile(hostPath);
    throw cause;
  }
}

export async function removeTemporaryFile(hostPath: string): Promise<boolean> {
  try {
    await unlink(hostPath);
    return true;
  } catch {
    // Cleanup is best-effort after the primary operation has failed.
    return false;
  }
}

export function decodeUtf8(content: Uint8Array, operation: WorkspaceOperation): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new WorkspaceError("unsupported-text-encoding", operation);
  }
}

async function callFilesystem<Result>(
  operation: WorkspaceOperation,
  action: () => Promise<Result>,
): Promise<Result> {
  try {
    return await action();
  } catch (cause: unknown) {
    if (cause instanceof WorkspaceError) {
      throw cause;
    }
    throw mapFilesystemError(cause, operation);
  }
}

function assertOpenedFile(current: Stats, expected: Stats, operation: WorkspaceOperation): void {
  if (!current.isFile() || current.nlink !== 1) {
    throw new WorkspaceError("unsafe-entry", operation);
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new WorkspaceError("unsafe-entry", operation);
  }
}

function parseBinaryChunk(boundaryInput: unknown, operation: WorkspaceOperation): Uint8Array {
  if (!(boundaryInput instanceof Uint8Array)) {
    throw new WorkspaceError("filesystem-failure", operation);
  }
  return boundaryInput;
}

function mapFilesystemError(cause: unknown, operation: WorkspaceOperation): WorkspaceError {
  if (hasErrorCode(cause, "ENOENT")) {
    return new WorkspaceError("not-found", operation);
  }
  if (hasErrorCode(cause, "EEXIST")) {
    return new WorkspaceError("already-exists", operation);
  }
  if (hasErrorCode(cause, "ENOTDIR")) {
    return new WorkspaceError("not-directory", operation);
  }
  if (hasErrorCode(cause, "ENOTEMPTY")) {
    return new WorkspaceError("directory-not-empty", operation);
  }
  if (hasErrorCode(cause, "EISDIR")) {
    return new WorkspaceError("not-regular-file", operation);
  }
  if (hasErrorCode(cause, "ELOOP")) {
    return new WorkspaceError("unsafe-entry", operation);
  }
  if (hasErrorCode(cause, "ENAMETOOLONG")) {
    return new WorkspaceError("invalid-path", operation);
  }
  return new WorkspaceError("filesystem-failure", operation);
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}
