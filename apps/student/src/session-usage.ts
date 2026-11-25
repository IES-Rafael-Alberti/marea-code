import type { MareaModelGateway } from "@marea/deepagents-adapter";
import { CONTEXT_WINDOW_CAPABILITY } from "@marea/protocol";
import * as z from "zod";

import type { SessionUsage } from "./contracts.js";

const tokens = z.number().int().nonnegative();

/** How `session.json` keeps a session's usage. */
export const StoredUsageSchema = z
  .object({
    inputTokens: tokens,
    outputTokens: tokens,
    lastInputTokens: tokens,
    contextWindowTokens: z.number().int().positive().optional(),
  })
  .strict()
  .readonly();

/** What one completed model call used, as the teacher's server reported it. */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextWindowTokens?: number | undefined;
}

/** Adds one call to the session totals; the latest call alone sets the input and the window. */
export function addUsage(total: SessionUsage | undefined, call: CallUsage): SessionUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + call.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + call.outputTokens,
    lastInputTokens: call.inputTokens,
    ...(call.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: call.contextWindowTokens }),
  };
}

/** The usage gateway together with the hook that tells it what the server supports. */
export function meterUsage(
  gateway: MareaModelGateway,
  record: (call: CallUsage) => Promise<SessionUsage>,
  show: ((usage: SessionUsage) => void) | undefined,
): {
  readonly gateway: UsageGateway;
  readonly onServerCapabilities: (all: readonly string[]) => void;
} {
  const metered = usageGateway(gateway, async (call) => {
    const usage = await record(call);
    show?.(usage);
  });
  return {
    gateway: metered,
    onServerCapabilities: (all) => {
      metered.reportWindow(all.includes(CONTEXT_WINDOW_CAPABILITY));
    },
  };
}

export interface UsageGateway extends MareaModelGateway {
  /** Called once the server says whether it reports the model's context window. */
  readonly reportWindow: (supported: boolean) => void;
}

/**
 * Hands the usage of every completed call to `record` before passing the completion on, and asks
 * for the context window only from a server that reports it.
 */
export function usageGateway(
  gateway: MareaModelGateway,
  record: (usage: CallUsage) => Promise<void>,
): UsageGateway {
  let window = false;
  return {
    reportWindow: (supported) => {
      window = supported;
    },
    async *stream(request, signal) {
      const sent = window ? { ...request, contextWindow: true as const } : request;
      for await (const chunk of gateway.stream(sent, signal)) {
        if (chunk.event === "completed") await record(chunk.usage);
        yield chunk;
      }
    },
  };
}
