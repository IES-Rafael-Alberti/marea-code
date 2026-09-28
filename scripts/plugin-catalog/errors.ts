export type PluginCatalogErrorCode =
  | "CATALOG_DRIFT"
  | "DUPLICATE_PLUGIN_ID"
  | "ENTRYPOINT_NOT_FOUND"
  | "INVALID_LAYOUT"
  | "INVALID_MANIFEST"
  | "READ_FAILED"
  | "UNSAFE_PATH";

export class PluginCatalogError extends Error {
  readonly code: PluginCatalogErrorCode;
  readonly location: string;

  constructor(code: PluginCatalogErrorCode, location: string, message: string) {
    super(`${code} at ${location}: ${message}`);
    this.name = "PluginCatalogError";
    this.code = code;
    this.location = location;
  }
}

export function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function errorMessage(error: unknown): string {
  return String(error);
}
