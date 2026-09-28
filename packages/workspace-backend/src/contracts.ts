export type WorkspaceOperation =
  "initialize" | "read" | "write" | "edit" | "list" | "delete" | "rename";

export type WorkspaceErrorCode =
  | "invalid-root"
  | "invalid-limit"
  | "invalid-path"
  | "not-found"
  | "already-exists"
  | "not-directory"
  | "directory-not-empty"
  | "not-regular-file"
  | "unsafe-entry"
  | "read-limit-exceeded"
  | "write-limit-exceeded"
  | "directory-limit-exceeded"
  | "edit-conflict"
  | "unsupported-text-encoding"
  | "filesystem-failure";

const ERROR_MESSAGES: Readonly<Record<WorkspaceErrorCode, string>> = {
  "invalid-root": "The workspace root is invalid.",
  "invalid-limit": "A workspace limit is invalid.",
  "invalid-path": "The virtual workspace path is invalid.",
  "not-found": "The workspace entry does not exist.",
  "already-exists": "The workspace entry already exists.",
  "not-directory": "The workspace entry is not a directory.",
  "directory-not-empty": "The workspace directory is not empty.",
  "not-regular-file": "The workspace entry is not a regular file.",
  "unsafe-entry": "The workspace entry is not safe to access.",
  "read-limit-exceeded": "The workspace read limit was exceeded.",
  "write-limit-exceeded": "The workspace write limit was exceeded.",
  "directory-limit-exceeded": "The workspace directory limit was exceeded.",
  "edit-conflict": "The requested workspace edit cannot be applied.",
  "unsupported-text-encoding": "The workspace file is not valid UTF-8 text.",
  "filesystem-failure": "The workspace operation failed.",
};

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly operation: WorkspaceOperation;

  constructor(code: WorkspaceErrorCode, operation: WorkspaceOperation) {
    super(ERROR_MESSAGES[code]);
    this.name = "WorkspaceError";
    this.code = code;
    this.operation = operation;
  }
}

export interface WorkspaceLimits {
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxDirectoryEntries: number;
}

export interface GuardedWorkspaceOptions {
  readonly rootPath: string;
  readonly limits?: Partial<WorkspaceLimits>;
}

export interface WorkspaceWriteOptions {
  readonly createParents?: boolean;
}

export interface WorkspaceTextEdit {
  readonly expected: string;
  readonly replacement: string;
  readonly occurrence?: "once" | "all";
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAt: string;
}

export interface WorkspaceBackend {
  readText(virtualPath: string): Promise<string>;
  writeText(virtualPath: string, content: string, options?: WorkspaceWriteOptions): Promise<void>;
  editText(virtualPath: string, edit: WorkspaceTextEdit): Promise<number>;
  list(virtualPath: string): Promise<readonly WorkspaceEntry[]>;
  deleteEntry(virtualPath: string): Promise<void>;
  renameEntry(sourcePath: string, destinationPath: string): Promise<void>;
}
