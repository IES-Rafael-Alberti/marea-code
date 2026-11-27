import select from "@inquirer/select";
import type { Translator } from "@marea/i18n";

import type { StudentVersionAcceptanceStore } from "./version-acceptance.boundary.js";

/** The student chose not to run Marea against a server of a different version. */
export class StudentVersionError extends Error {
  /** `message` is already translated for the student. */
  constructor(message: string) {
    super(message);
    this.name = "StudentVersionError";
  }
}

export type VersionGate = (serverVersion: string, clientVersion: string) => Promise<void>;

export interface VersionGateOptions {
  readonly serverUrl: string;
  readonly translator: Translator;
  readonly store?: StudentVersionAcceptanceStore | undefined;
  readonly interactive?: () => boolean;
  readonly confirm?: (message: string, choices: readonly VersionChoice[]) => Promise<boolean>;
}

interface VersionChoice {
  readonly name: string;
  readonly value: boolean;
}

function terminalIsInteractive(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function askWithSelect(message: string, choices: readonly VersionChoice[]): Promise<boolean> {
  return select({ message, choices: [...choices] });
}

/**
 * Different software versions are allowed only when the student accepts the risk, once for each
 * server and pair of versions. The default answer is to leave; without a terminal Marea never
 * waits for an answer and refuses unless the pair was accepted before.
 */
export function createVersionGate(options: VersionGateOptions): VersionGate {
  const { serverUrl, translator, store } = options;
  const interactive = options.interactive ?? terminalIsInteractive;
  const confirm = options.confirm ?? askWithSelect;
  return async (serverVersion, clientVersion) => {
    const pair = { serverUrl, serverVersion, clientVersion };
    if ((await store?.has(pair)) === true) return;
    const lines = [
      translator.t("student.version.mismatch", { client: clientVersion, server: serverVersion }),
      translator.t("student.version.recommendation"),
    ];
    if (!interactive())
      throw new StudentVersionError(
        [...lines, translator.t("student.version.terminal-required")].join("\n"),
      );
    const accepted = await confirm(
      [...lines, translator.t("student.version.question")].join("\n"),
      [
        { name: translator.t("student.version.exit"), value: false },
        { name: translator.t("student.version.continue"), value: true },
      ],
    );
    if (!accepted)
      throw new StudentVersionError(
        [...lines, translator.t("student.version.declined")].join("\n"),
      );
    // An acceptance that cannot be saved still applies to this session.
    await store?.remember(pair).catch(() => undefined);
  };
}
