import { WorkspaceError, type WorkspaceOperation } from "./contracts.js";

const MAXIMUM_VIRTUAL_PATH_BYTES = 4_096;
const WINDOWS_RESERVED_NAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export interface VirtualPath {
  readonly value: string;
  readonly segments: readonly string[];
}

export function parseVirtualPath(input: string, operation: WorkspaceOperation): VirtualPath {
  if (
    !hasValidShape(input) ||
    input.length > MAXIMUM_VIRTUAL_PATH_BYTES ||
    new TextEncoder().encode(input).byteLength > MAXIMUM_VIRTUAL_PATH_BYTES
  ) {
    throw new WorkspaceError("invalid-path", operation);
  }

  const segments = input === "/" ? [] : input.slice(1).split("/");
  if (segments.some(isInvalidSegment)) {
    throw new WorkspaceError("invalid-path", operation);
  }

  return { value: input, segments };
}

export function appendVirtualPath(parent: VirtualPath, name: string): VirtualPath {
  const value = parent.value === "/" ? `/${name}` : `${parent.value}/${name}`;
  return parseVirtualPath(value, "list");
}

function hasValidShape(input: string): boolean {
  return input.startsWith("/") && !input.includes("\\") && !hasControlCharacter(input);
}

function hasControlCharacter(input: string): boolean {
  for (const character of input) {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit < 32 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

function isInvalidSegment(segment: string): boolean {
  if (segment.length === 0) {
    return true;
  }
  if (segment.includes(":") || segment.endsWith(".") || segment.endsWith(" ")) {
    return true;
  }
  if (segment.toLowerCase().startsWith(".marea-")) {
    return true;
  }
  return WINDOWS_RESERVED_NAME.test(segment);
}
