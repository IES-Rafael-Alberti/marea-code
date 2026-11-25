import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";

import {
  parseLocalePreference,
  resolveLocalePreference,
  type LocalePreference,
  type LocaleResolution,
} from "@marea/i18n";

import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";

export interface ParsedLanguageArguments {
  readonly arguments: readonly string[];
  readonly preference: LocalePreference | undefined;
  readonly invalid: string | undefined;
}

export function parseLanguageArguments(
  arguments_: readonly (string | undefined)[],
): ParsedLanguageArguments {
  const remaining: string[] = [];
  let preference: LocalePreference | undefined;
  let invalid: string | undefined;
  const pending = arguments_.values();
  for (const argument of pending) {
    if (argument === undefined) continue;
    if (argument === "--lang") {
      const value = pending.next().value;
      if (value === undefined || preference !== undefined) {
        invalid = value ?? "";
        continue;
      }
      const parsed = parseLocalePreference(value);
      if (parsed === null) invalid = value;
      else preference = parsed;
      continue;
    }
    if (argument.startsWith("--lang=")) {
      const value = argument.slice("--lang=".length);
      if (preference !== undefined) {
        invalid = value;
        continue;
      }
      const parsed = parseLocalePreference(value);
      if (parsed === null) invalid = value;
      else preference = parsed;
      continue;
    }
    remaining.push(argument);
  }
  return Object.freeze({ arguments: Object.freeze(remaining), preference, invalid });
}

export function systemLocaleCandidates(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.freeze(
    [environment.LC_ALL, environment.LC_MESSAGES, environment.LANG].filter(
      (value): value is string => value !== undefined && value.trim() !== "",
    ),
  );
}

export function resolveStudentLocale(options: {
  readonly commandLine: string | null | undefined;
  readonly environment: string | null | undefined;
  readonly saved: string | null | undefined;
  readonly system: readonly string[];
}): LocaleResolution {
  return resolveLocalePreference(options);
}

type LanguageSettings = Readonly<Record<string, unknown>>;
const LanguageSettingsSchema = z.record(z.string(), z.unknown());
const StoredPreferenceSchema = z.string().nullish();

function isLanguageSettings(value: unknown): value is LanguageSettings {
  return LanguageSettingsSchema.safeParse(value).success;
}

function parseLanguageSettings(content: string | null): LanguageSettings {
  if (content === null) return {};
  const value: unknown = JSON.parse(content);
  if (!isLanguageSettings(value)) throw new Error("Marea settings are not a JSON object.");
  return value;
}

const LANGUAGE_PREFERENCE_KEY = "marea.interface-language.v1";

export interface StudentLanguagePreferenceStore {
  load(): Promise<LocalePreference | null>;
  save(preference: LocalePreference): Promise<void>;
}

/** Reads one value of the shared settings file; an unreadable file counts as unset. */
async function loadSetting(path: string, key: string): Promise<unknown> {
  try {
    return parseLanguageSettings(await readPrivateTextFile(path))[key];
  } catch {
    // An unreadable settings file counts as unset.
  }
  return undefined;
}

/** Writes one value of the shared settings file, keeping every other value. */
async function saveSetting(stateRoot: string, key: string, value: unknown): Promise<void> {
  const path = join(resolve(stateRoot), "settings.json");
  await mkdir(resolve(stateRoot), { recursive: true, mode: 0o700 });
  const current = parseLanguageSettings(await readPrivateTextFile(path));
  await writePrivateFileAtomically(path, JSON.stringify({ ...current, [key]: value }));
}

export function createStudentLanguagePreferenceStore(
  stateRoot: string,
): StudentLanguagePreferenceStore {
  const path = join(resolve(stateRoot), "settings.json");
  return Object.freeze({
    async load(): Promise<LocalePreference | null> {
      try {
        return parseLocalePreference(
          StoredPreferenceSchema.parse(await loadSetting(path, LANGUAGE_PREFERENCE_KEY)),
        );
      } catch {
        return null;
      }
    },
    save: (preference: LocalePreference) =>
      saveSetting(stateRoot, LANGUAGE_PREFERENCE_KEY, preference),
  });
}

const USAGE_LINE_KEY = "marea.usage-line.v1";

/** Whether the student keeps the `/usage` line visible, across sessions and projects. */
export interface StudentUsagePreferenceStore {
  load(): Promise<boolean>;
  save(visible: boolean): Promise<void>;
}

export function createStudentUsagePreferenceStore(stateRoot: string): StudentUsagePreferenceStore {
  const path = join(resolve(stateRoot), "settings.json");
  return Object.freeze({
    load: async () => (await loadSetting(path, USAGE_LINE_KEY)) === true,
    save: (visible: boolean) => saveSetting(stateRoot, USAGE_LINE_KEY, visible),
  });
}
