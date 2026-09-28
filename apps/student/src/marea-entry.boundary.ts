import { homedir } from "node:os";
import { join } from "node:path";

import { createTranslator, parseLocalePreference, selectLocale } from "@marea/i18n";

import {
  createStudentLanguagePreferenceStore,
  parseLanguageArguments,
  resolveStudentLocale,
  systemLocaleCandidates,
} from "./interface-locale.boundary.js";
import { executeMareaCommand, type MareaCommandOutput } from "./marea-command.boundary.js";

export function createProcessCommandOutput(): MareaCommandOutput {
  return Object.freeze({
    error: (text: string) => process.stderr.write(text),
    write: (text: string) => process.stdout.write(text),
  });
}

const parsedArguments = parseLanguageArguments(process.argv.slice(2));
const configuredStateRoot = process.env.MAREA_STATE_HOME?.trim();
const stateRoot =
  configuredStateRoot === undefined || configuredStateRoot === ""
    ? join(homedir(), ".marea")
    : configuredStateRoot;
const preferenceStore = createStudentLanguagePreferenceStore(stateRoot);
const savedPreference = await preferenceStore.load();
const environmentLanguage = process.env.MAREA_LANG?.trim();
function isInvalidEnvironmentLanguage(value: string | undefined): value is string {
  return value !== undefined && value !== "" && parseLocalePreference(value) === null;
}
const invalidEnvironment = isInvalidEnvironmentLanguage(environmentLanguage);
const output = createProcessCommandOutput();
if (parsedArguments.invalid !== undefined) {
  output.error(
    `${createTranslator("es").t("student.cli.invalid-language", { option: parsedArguments.invalid })}\n`,
  );
  process.exitCode = 2;
} else if (invalidEnvironment) {
  output.error(
    `${createTranslator("es").t("student.cli.invalid-language", { option: environmentLanguage })}\n`,
  );
  process.exitCode = 2;
} else {
  const systemLocales = systemLocaleCandidates(process.env);
  const resolution = resolveStudentLocale({
    commandLine: parsedArguments.preference,
    environment: environmentLanguage,
    saved: savedPreference,
    system: systemLocales,
  });
  process.exitCode = await executeMareaCommand({
    arguments: parsedArguments.arguments,
    currentDirectory: process.cwd(),
    homeDirectory: homedir(),
    output,
    serverUrl: process.env.MAREA_SERVER_URL,
    stateRoot: process.env.MAREA_STATE_HOME,
    translator: createTranslator(resolution.locale),
    languagePreference: resolution.preference,
    automaticLocale: selectLocale(systemLocales),
    languagePreferenceStore: preferenceStore,
  });
}
