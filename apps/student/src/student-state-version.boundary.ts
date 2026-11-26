import { ZodError } from "zod";

/**
 * The saved session was written by a newer Marea. Reading it as damaged data would set it
 * aside and lose its undelivered events, so startup stops and asks for an update instead.
 */
export class StudentStateNewerVersionError extends Error {
  readonly diagnosticCode = "local-state.newer-version";

  constructor() {
    super("The student state was written by a newer version of Marea.");
    this.name = "StudentStateNewerVersionError";
  }
}

/** A version number above the supported one can only come from a newer client. */
export function assertStateVersionNotNewer(version: unknown, supported: number): void {
  if (typeof version === "number" && version > supported) throw new StudentStateNewerVersionError();
}

/**
 * A current-version file that is valid except for fields this client does not know was written
 * by a newer client that added them. Any other failure keeps its damaged-data handling.
 */
export function refuseUnknownFields(error: unknown): unknown {
  return error instanceof ZodError &&
    error.issues.length > 0 &&
    error.issues.every((issue) => issue.code === "unrecognized_keys")
    ? new StudentStateNewerVersionError()
    : error;
}
