import { lstatSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";

import { createOperatorConfiguration } from "./operator-configuration-adapter.js";
import { OperatorConfigurationError } from "./operator-configuration-errors.js";
import type { OperatorConfigurationErrorCode } from "./operator-configuration-errors.js";
import { parseOperatorDocument } from "./operator-configuration-parser.js";
import { readOperatorFile } from "./operator-file-read.boundary.js";

export interface OperatorFilesystem {
  isAbsolute(path: string): boolean;
  lstat(path: string): Stats | undefined;
  readFile(path: string, maxBytes: number): Buffer;
}

const defaultFilesystem: OperatorFilesystem = {
  isAbsolute,
  lstat(path) {
    return lstatSync(path, { throwIfNoEntry: false });
  },
  readFile: readOperatorFile,
};

function failed(code: OperatorConfigurationErrorCode, message: string) {
  return new OperatorConfigurationError(code, message);
}

function fileStatus(path: string, filesystem: OperatorFilesystem) {
  try {
    return filesystem.lstat(path);
  } catch {
    throw failed("access-denied", "Operator configuration file cannot be inspected.");
  }
}

function requireRegularFile(path: string, filesystem: OperatorFilesystem) {
  const status = fileStatus(path, filesystem);
  if (status === undefined) {
    throw failed("not-found", "Operator configuration file is unavailable.");
  }
  if (status.isSymbolicLink()) {
    throw failed("symlink", "Operator configuration path must be a regular file.");
  }
  if (!status.isFile()) {
    throw failed("not-regular-file", "Operator configuration path must be a regular file.");
  }
  return status;
}

function requireByteBound(path: string, maxBytes: number, filesystem: OperatorFilesystem) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw failed("invalid-bound", "Operator configuration byte bound must be positive.");
  }
  if (!filesystem.isAbsolute(path)) {
    throw failed("invalid-path", "Operator configuration path must be absolute.");
  }
}

export function readBoundedBytes(
  path: string,
  maxBytes: number,
  filesystem: OperatorFilesystem = defaultFilesystem,
) {
  requireByteBound(path, maxBytes, filesystem);
  const before = requireRegularFile(path, filesystem);
  if (before.size > maxBytes) {
    throw failed("too-large", "Operator configuration exceeds its byte bound.");
  }
  let bytes: Buffer;
  try {
    bytes = filesystem.readFile(path, maxBytes);
  } catch (error) {
    if (error instanceof OperatorConfigurationError) throw error;
    throw failed("io-failure", "Operator configuration file could not be read.");
  }
  const after = requireRegularFile(path, filesystem);
  assertPostReadBounds(before, after, bytes, maxBytes);
  return bytes;
}

export function assertPostReadBounds(before: Stats, after: Stats, bytes: Buffer, maxBytes: number) {
  if (bytes.byteLength > maxBytes) {
    throw failed("too-large", "Operator configuration exceeds its byte bound.");
  }
  if (
    after.size !== before.size ||
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    throw failed("changed-file", "Operator configuration changed while being read.");
  }
}

export function loadOperatorConfiguration(path: string, maxBytes: number) {
  const bytes = readBoundedBytes(path, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failed("invalid-document", "Operator configuration is not valid UTF-8.");
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    throw failed("invalid-document", "Operator configuration is not valid JSON.");
  }
  return createOperatorConfiguration(parseOperatorDocument(document));
}
