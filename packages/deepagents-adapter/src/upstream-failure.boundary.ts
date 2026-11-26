import { AgentAdapterError, type AgentEvent } from "./contracts.js";

export interface DiagnosticCause {
  readonly name: string;
  readonly message: string;
}

const diagnosticCauseRegistry = new WeakMap<AgentAdapterError, DiagnosticCause>();

export function diagnosticCauseFor(error: AgentAdapterError): DiagnosticCause | null {
  return diagnosticCauseRegistry.get(error) ?? null;
}

export function normalizeDiagnosticCause(input: unknown): DiagnosticCause {
  return input instanceof Error
    ? Object.freeze({ name: input.name, message: input.message })
    : Object.freeze({
        name: "NonErrorThrownValue",
        message: "The upstream runtime threw a non-Error value.",
      });
}

export async function safelyRecordTurn(
  recordTurn:
    | ((
        state: "pending-approval" | "in-progress" | "completed",
        events: readonly AgentEvent[],
      ) => Promise<void>)
    | undefined,
  state: "pending-approval" | "in-progress" | "completed",
  events: readonly AgentEvent[],
): Promise<void> {
  try {
    await recordTurn?.(state, events);
  } catch (error: unknown) {
    if (error instanceof AgentAdapterError) throw error;
    throw upstreamFailure(error);
  }
}

export function upstreamFailure(error: unknown): AgentAdapterError {
  const adapterError = new AgentAdapterError(
    "upstream-execution-failed",
    "The agent runtime failed without exposing provider diagnostics.",
  );
  // The classifier downstream reads the typed cause; prose is never parsed.
  // Non-enumerable, so the cause never leaks into serialized errors.
  Object.defineProperty(adapterError, "cause", { value: error });
  diagnosticCauseRegistry.set(adapterError, normalizeDiagnosticCause(error));
  return adapterError;
}
