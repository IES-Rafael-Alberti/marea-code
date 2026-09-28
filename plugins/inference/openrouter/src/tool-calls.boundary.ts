import * as z from "zod";

import type { InferenceProviderEvent } from "@marea/plugin-api";
import { InferenceProviderError } from "@marea/plugin-api";

import type { OpenRouterToolCallDelta } from "./contracts.js";

interface PendingToolCall {
  argumentsText: string;
  id: string;
  name: string;
}

const toolArgumentsSchema = z.record(z.string().min(1).max(128), z.string());

function parseArguments(text: string): Readonly<Record<string, string>> {
  try {
    const result = toolArgumentsSchema.safeParse(JSON.parse(text) as unknown);
    return result.success ? Object.freeze(result.data) : invalidToolCall();
  } catch {
    return invalidToolCall();
  }
}

function invalidToolCall(): never {
  throw new InferenceProviderError({
    code: "invalid-response",
    message: "The inference provider returned an invalid tool call.",
    retryable: false,
  });
}

export class ToolCallAccumulator {
  readonly #calls = new Map<number, PendingToolCall>();

  public add(deltas: readonly OpenRouterToolCallDelta[]): void {
    for (const delta of deltas) {
      const previous = this.#calls.get(delta.index);
      const id = delta.id ?? previous?.id;
      const name = delta.name ?? previous?.name;
      if (id === undefined || name === undefined) {
        invalidToolCall();
      }
      this.#calls.set(delta.index, {
        argumentsText: (previous?.argumentsText ?? "") + (delta.arguments ?? ""),
        id,
        name,
      });
    }
  }

  public finish(): readonly InferenceProviderEvent[] {
    return Object.freeze(
      [...this.#calls.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([, call]) => {
          return Object.freeze({
            arguments: parseArguments(call.argumentsText),
            callId: call.id,
            name: call.name,
            type: "tool-call" as const,
          });
        }),
    );
  }
}
