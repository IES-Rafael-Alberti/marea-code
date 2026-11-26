import type {
  InferenceProviderEvent,
  InferenceToolCallRepair,
  InferenceToolCallRepairCause,
} from "@marea/plugin-api";

import type { OpenRouterToolCallDelta } from "./contracts.js";

interface PendingToolCall {
  argumentsText: string;
  id: string | undefined;
  name: string | undefined;
}

/** The gateway's tool-name and call-id grammars; a call outside them is repaired, not rejected. */
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,127}$/u;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_ARGUMENT_NAME = 128;
const MAX_RAW_ARGUMENTS = 4_096;
/** A name no tool has, so the agent answers with its unknown-tool error and the tool list. */
export const UNKNOWN_TOOL_NAME = "unknown_tool";

function argumentValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  return value === null ? null : JSON.stringify(value);
}

/**
 * Tool arguments are a flat string record. Scalars become text and nested values JSON text so a
 * model that sends `"offset": 20` still reaches the tool; anything unreadable becomes `{}` and the
 * tool's own validation tells the model which parameters it expects.
 */
function parseArguments(
  text: string,
  causes: Set<InferenceToolCallRepairCause>,
): Readonly<Record<string, string>> {
  if (text.trim().length === 0) return Object.freeze({});
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unreadable text is handled below like any other value that is not an object.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    causes.add("malformed-arguments");
    return Object.freeze({});
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.length === 0 || key.length > MAX_ARGUMENT_NAME) {
      causes.add("malformed-arguments");
      continue;
    }
    if (typeof value !== "string") causes.add("non-string-argument");
    const text = argumentValue(value);
    if (text !== null) result[key] = text;
  }
  return Object.freeze(result);
}

/** A short stable digest so repaired call ids of different responses do not collide. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function callName(name: string | undefined, causes: Set<InferenceToolCallRepairCause>): string {
  if (name === undefined || name.length === 0) {
    causes.add("missing-name");
    return UNKNOWN_TOOL_NAME;
  }
  if (TOOL_NAME.test(name)) return name;
  causes.add("invalid-name");
  return UNKNOWN_TOOL_NAME;
}

export class ToolCallAccumulator {
  readonly #calls = new Map<number, PendingToolCall>();
  readonly #idPrefix: string;

  /** `responseKey` identifies this response; it only seeds ids for calls that arrive without one. */
  public constructor(responseKey: string) {
    this.#idPrefix = `call-${digest(responseKey)}`;
  }

  public add(deltas: readonly OpenRouterToolCallDelta[]): void {
    for (const delta of deltas) {
      const previous = this.#calls.get(delta.index);
      this.#calls.set(delta.index, {
        argumentsText: (previous?.argumentsText ?? "") + (delta.arguments ?? ""),
        id: delta.id ?? previous?.id,
        name: delta.name ?? previous?.name,
      });
    }
  }

  public finish(): readonly InferenceProviderEvent[] {
    const seen = new Set<string>();
    return Object.freeze(
      [...this.#calls.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([index, call]) => this.#event(index, call, seen)),
    );
  }

  #event(index: number, call: PendingToolCall, seen: Set<string>): InferenceProviderEvent {
    const causes = new Set<InferenceToolCallRepairCause>();
    const name = callName(call.name, causes);
    let callId = call.id;
    if (callId === undefined || callId.length === 0) {
      causes.add("missing-id");
      callId = `${this.#idPrefix}-${String(index)}`;
    } else if (!CALL_ID.test(callId)) {
      causes.add("invalid-id");
      callId = `${this.#idPrefix}-${String(index)}`;
    }
    // The gateway refuses a message whose call ids repeat; the first call keeps its id.
    if (seen.has(callId)) {
      causes.add("duplicate-id");
      callId = `${this.#idPrefix}-${String(index)}`;
      for (let attempt = 1; seen.has(callId); attempt += 1) {
        callId = `${this.#idPrefix}-${String(index)}-${String(attempt)}`;
      }
    }
    seen.add(callId);
    const parsed = parseArguments(call.argumentsText, causes);
    const event = { arguments: parsed, callId, name, type: "tool-call" as const };
    if (causes.size === 0) return Object.freeze(event);
    const repair: InferenceToolCallRepair = Object.freeze({
      causes: Object.freeze([...causes]),
      rawName: call.name ?? null,
      rawArguments: call.argumentsText.slice(0, MAX_RAW_ARGUMENTS),
    });
    return Object.freeze({ ...event, repair });
  }
}
