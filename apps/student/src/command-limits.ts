/** Limits for shell commands the agent runs on the student's computer. */
export const COMMAND_DEADLINE_MS = 10 * 60_000;
/** Output kept from the start of a command, where its banner and first errors are. */
export const COMMAND_OUTPUT_HEAD_CHARACTERS = 4_096;
/** Output kept from the end of a command, where its result and final errors are. */
export const COMMAND_OUTPUT_TAIL_CHARACTERS = 12_288;
