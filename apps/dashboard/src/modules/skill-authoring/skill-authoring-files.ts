import {
  isSkillFilePath,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  type SkillAuthoringDraft,
} from "@marea/protocol";

const MAX_IMPORTED_FILES = 256;
type DraftFiles = SkillAuthoringDraft["files"];

export type SkillAuthoringFileProblem =
  | "unavailable"
  | "invalid-path"
  | "duplicate-path"
  | "too-many-files"
  | "too-large"
  | "invalid-text";

/** A deliberately small file shape makes browser I/O straightforward to inject in tests. */
export interface SkillAuthoringFileSource {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SkillAuthoringImportFile {
  readonly path: string;
  readonly file: SkillAuthoringFileSource;
}

export interface SkillAuthoringDirectoryEntry {
  readonly name: string;
  /** Browser handles are runtime data; unknown kinds are rejected by the walker. */
  readonly kind: string;
  readonly getFile?: () => Promise<SkillAuthoringFileSource>;
  readonly values?: () => AsyncIterable<SkillAuthoringDirectoryEntry>;
}

export interface SkillAuthoringDirectorySource {
  values(): AsyncIterable<SkillAuthoringDirectoryEntry>;
}

export interface SkillAuthoringBrowserAdapter {
  chooseDirectory(): Promise<SkillAuthoringDirectorySource | null>;
  downloadFile(fileName: string, content: string, saved: boolean): Promise<void>;
}

export interface SkillAuthoringFileExchange {
  importDirectory(): Promise<DraftFiles | null>;
  importExplicit(files: readonly SkillAuthoringImportFile[]): Promise<DraftFiles>;
  exportFile(path: string, content: string, saved: boolean): Promise<void>;
}

export class SkillAuthoringFileError extends Error {
  readonly code: SkillAuthoringFileProblem;

  constructor(code: SkillAuthoringFileProblem, message: string) {
    super(message);
    this.name = "SkillAuthoringFileError";
    this.code = code;
  }
}

function invalid(code: SkillAuthoringFileProblem, message: string): SkillAuthoringFileError {
  return new SkillAuthoringFileError(code, message);
}

function invalidOuterPath(path: string): boolean {
  return (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^\.\.?\//u.test(path) ||
    /^[A-Za-z]:/u.test(path)
  );
}

function normalizedImportPath(path: string): string {
  const candidate = path.split("/");
  const relativeCandidate =
    candidate.length > 1 && candidate[0] !== "resources" ? candidate.slice(1).join("/") : path;
  const pathToCheck = restoreDownloadPath(relativeCandidate);
  if (invalidOuterPath(path) || pathToCheck.length > 1_024 || !isSkillFilePath(pathToCheck)) {
    throw invalid("invalid-path", "Use a contained canonical skill text-file path.");
  }
  return pathToCheck;
}

/** Only flat download names are encoded; real directory paths retain literal percent signs. */
function restoreDownloadPath(path: string): string {
  if (path.includes("/")) return path;
  const encoded = path.startsWith("draft__") ? path.slice("draft__".length) : path;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw invalid("invalid-path", "Use a contained canonical skill text-file path.");
  }
}

async function decodeTextFile(file: SkillAuthoringFileSource): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SKILL_FILE_BYTES) {
    throw invalid("too-large", "A skill file exceeds the 512 KiB limit.");
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw invalid("invalid-text", "A selected file could not be read.");
  }
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw invalid("too-large", "A skill file exceeds the 512 KiB limit.");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("invalid-text", "Skill files must contain valid UTF-8 text.");
  }
  if (!content.isWellFormed() || content.includes("\0")) {
    throw invalid("invalid-text", "Skill files must be well-formed text without NUL bytes.");
  }
  return content;
}

/** Reads explicit relative files with the same complete-bundle bounds as the protocol. */
export async function readSkillAuthoringFiles(
  files: readonly SkillAuthoringImportFile[],
): Promise<DraftFiles> {
  if (files.length === 0 || files.length > MAX_IMPORTED_FILES) {
    throw invalid("too-many-files", "A skill must contain between one and 256 files.");
  }
  const paths = new Set<string>();
  const result: { readonly path: string; readonly content: string }[] = [];
  let totalBytes = 0;
  for (const entry of files) {
    const path = normalizedImportPath(entry.path);
    if (paths.has(path)) {
      throw invalid("duplicate-path", "Skill file paths must be unique.");
    }
    paths.add(path);
    const content = await decodeTextFile(entry.file);
    totalBytes += new TextEncoder().encode(content).byteLength;
    if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
      throw invalid("too-large", "The complete skill exceeds the 8 MiB limit.");
    }
    result.push({ path, content });
  }
  if (!paths.has("SKILL.md")) {
    throw invalid("invalid-path", "A complete skill must contain SKILL.md.");
  }
  return result;
}

async function collectDirectoryFiles(
  directory: SkillAuthoringDirectorySource,
  prefix: string,
  result: SkillAuthoringImportFile[],
): Promise<void> {
  try {
    for await (const entry of directory.values()) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.kind === "file") {
        if (entry.getFile === undefined) {
          throw invalid("unavailable", "A selected file could not be opened.");
        }
        result.push({ path, file: await entry.getFile() });
        if (result.length > MAX_IMPORTED_FILES) {
          throw invalid("too-many-files", "A skill cannot contain more than 256 files.");
        }
      } else if (entry.kind === "directory") {
        if (entry.values === undefined) {
          throw invalid("unavailable", "A selected directory could not be opened.");
        }
        await collectDirectoryFiles({ values: entry.values }, path, result);
      } else {
        throw invalid("unavailable", "A selected directory entry has an invalid kind.");
      }
    }
  } catch (error) {
    if (error instanceof SkillAuthoringFileError) throw error;
    throw invalid("unavailable", "The selected directory could not be read.");
  }
}

export async function readSkillAuthoringDirectory(
  directory: SkillAuthoringDirectorySource,
): Promise<DraftFiles> {
  const files: SkillAuthoringImportFile[] = [];
  await collectDirectoryFiles(directory, "", files);
  return readSkillAuthoringFiles(files);
}

export function createSkillAuthoringFileExchange(
  adapter: SkillAuthoringBrowserAdapter,
): SkillAuthoringFileExchange {
  return {
    importDirectory: async () => {
      const directory = await adapter.chooseDirectory();
      return directory === null ? null : readSkillAuthoringDirectory(directory);
    },
    importExplicit: readSkillAuthoringFiles,
    exportFile: (path, content, saved) => adapter.downloadFile(path, content, saved),
  };
}

interface BrowserGlobal {
  readonly showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  readonly document?: Document;
  readonly URL?: typeof URL;
}

function browserGlobal(): BrowserGlobal {
  return globalThis;
}

async function* adaptNativeEntries(
  entries: AsyncIterable<FileSystemHandle>,
): AsyncIterable<SkillAuthoringDirectoryEntry> {
  for await (const entry of entries) {
    if (entry.kind === "file") {
      const fileHandle = entry as FileSystemFileHandle;
      yield {
        kind: "file",
        name: entry.name,
        getFile: () => fileHandle.getFile(),
      };
    } else {
      const directoryHandle = entry as FileSystemDirectoryHandle;
      yield {
        kind: "directory",
        name: entry.name,
        values: () => adaptNativeEntries(directoryHandle.values()),
      };
    }
  }
}

function adaptNativeDirectory(handle: FileSystemDirectoryHandle): SkillAuthoringDirectorySource {
  return { values: () => adaptNativeEntries(handle.values()) };
}

async function chooseNativeDirectory(): Promise<SkillAuthoringDirectorySource | null> {
  const picker = browserGlobal().showDirectoryPicker;
  if (picker === undefined) {
    throw invalid("unavailable", "Directory selection is unavailable in this browser.");
  }
  try {
    return adaptNativeDirectory(await picker());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return null;
    throw invalid("unavailable", "The selected directory could not be read.");
  }
}

async function downloadNativeFile(
  fileName: string,
  content: string,
  saved: boolean,
): Promise<void> {
  await Promise.resolve();
  const { document, URL: urlApi } = browserGlobal();
  if (document === undefined || urlApi === undefined) {
    throw invalid("unavailable", "File export is unavailable in this browser.");
  }
  const anchor = document.createElement("a");
  const objectUrl = urlApi.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  anchor.href = objectUrl;
  const prefix = saved ? "" : "draft__";
  anchor.download = `${prefix}${encodeURIComponent(fileName)}`;
  anchor.click();
  urlApi.revokeObjectURL(objectUrl);
}

/** Default browser implementation; no operation runs until an explicit user action. */
export function createBrowserSkillAuthoringFileExchange(): SkillAuthoringFileExchange {
  return createSkillAuthoringFileExchange({
    chooseDirectory: chooseNativeDirectory,
    downloadFile: downloadNativeFile,
  });
}
