import type { Translator } from "@marea/i18n";

import type { CredentialStore } from "./contracts.js";
import { createFileStudentStores } from "./filesystem.boundary.js";

export interface LogoutCommandOptions {
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly translator: Translator;
  readonly output: { write(text: string): void };
}

export interface LogoutCommandRuntime {
  readonly stores: (options: {
    readonly projectRoot: string;
    readonly stateDirectory: string;
  }) => Promise<{ readonly credentials: CredentialStore }>;
}

const production: LogoutCommandRuntime = { stores: createFileStudentStores };

/**
 * Forgets the stored sign-in of this server and project, so the next `marea` asks how to sign in.
 * It never contacts the server, never revokes the token and keeps the rest of the session state.
 * Signing out twice is not an error.
 */
export async function runLogoutCommand(
  options: LogoutCommandOptions,
  runtime: LogoutCommandRuntime = production,
): Promise<number> {
  const { credentials } = await runtime.stores({
    projectRoot: options.projectRoot,
    stateDirectory: options.stateDirectory,
  });
  await credentials.clear();
  options.output.write(`${options.translator.t("student.cli.logout-done")}\n`);
  return 0;
}
