import type { CommandDescriptions } from "./copy.js";

/**
 * Local commands and the suggestion strip.
 *
 * A local command is handled by the interface and never becomes a message to
 * the model. The words themselves are not translated — they are what the
 * student types — so only their descriptions come from the copy. Spanish
 * aliases are accepted for the same reason the reference accepts them: a
 * student who types `/salir` means `/exit`.
 */

export type LocalCommand = "details" | "exit" | "help" | "language" | "retry";

const ALIASES = new Map<string, LocalCommand>([
  ["/ayuda", "help"],
  ["/details", "details"],
  ["/exit", "exit"],
  ["/help", "help"],
  ["/lang", "language"],
  ["/language", "language"],
  ["/reintentar", "retry"],
  ["/retry", "retry"],
  ["/salir", "exit"],
]);

/** The suggested commands, in the reference's order. */
const SUGGESTED: readonly LocalCommand[] = Object.freeze([
  "exit",
  "help",
  "language",
  "retry",
  "details",
] as const);

const VALUES: Readonly<Record<LocalCommand, string>> = Object.freeze({
  details: "/details",
  exit: "/exit",
  help: "/help",
  language: "/language",
  retry: "/retry",
});

/** The command a submitted line stands for, or null for an ordinary message. */
export function localCommand(text: string): LocalCommand | null {
  return ALIASES.get(text.trim()) ?? null;
}

export interface CommandSuggestion {
  readonly command: LocalCommand;
  readonly description: string;
  readonly value: string;
}

/** Every suggestible command with its description. */
export function commandList(copy: CommandDescriptions): readonly CommandSuggestion[] {
  return SUGGESTED.map((command) => ({
    command,
    description: copy[command],
    value: VALUES[command],
  }));
}

/**
 * The suggestions for what the student has typed. Only a draft that starts
 * with a slash suggests anything, and since no command contains a space, a
 * message that merely mentions one never matches.
 */
export function suggestionsFor(
  copy: CommandDescriptions,
  text: string,
): readonly CommandSuggestion[] {
  const prefix = text.trim();
  if (!prefix.startsWith("/")) return [];
  return commandList(copy).filter((suggestion) => suggestion.value.startsWith(prefix));
}

/** What Tab completes the draft to, or null when nothing matches. */
export function completionFor(copy: CommandDescriptions, text: string): string | null {
  return suggestionsFor(copy, text)[0]?.value ?? null;
}
