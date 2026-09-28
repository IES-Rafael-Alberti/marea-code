import {
  type InferenceCancellation,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";

import { NOW, setup } from "../../test-support/history-fixture.js";
import {
  USAGE_ACCOUNT as account,
  USAGE_POLICY as policy,
  USAGE_REQUEST as request,
} from "../../test-support/usage-fixture.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { BudgetedInferenceProvider } from "./budgeted-provider.boundary.js";
import { cancellationFor } from "./inference-cancellation.js";
import { providerStream } from "./provider-stream.boundary.js";

export const usage: InferenceProviderEvent = { type: "usage", inputTokens: 5, outputTokens: 6 };
export const completed: InferenceProviderEvent = { type: "completed", finishReason: "stop" };
export const limitError = {
  code: "budget-exhausted",
  message: "The session has insufficient inference budget.",
  retryable: false,
};
export const signal = () => new AbortController().signal;
export const cancellation = () => cancellationFor(signal());

class FixtureProvider {
  readonly requests: InferenceProviderRequest[] = [];
  events: InferenceProviderEvent[] = [usage, completed];
  failure: Error | null = null;
  cancellation: InferenceCancellation | null = null;
  closed = false;

  async *stream(
    input: InferenceProviderRequest,
    cancel: InferenceCancellation,
  ): AsyncIterable<InferenceProviderEvent> {
    await Promise.resolve();
    this.requests.push(input);
    this.cancellation = cancel;
    try {
      for (const event of this.events) yield event;
      if (this.failure !== null) throw this.failure;
    } finally {
      this.closed = true;
    }
  }
}

export function fixture(configuredPolicy = policy) {
  const { database } = setup();
  const ledger = new SqliteUsageLedger(database);
  ledger.configure(account, configuredPolicy, NOW);
  const provider = new FixtureProvider();
  let index = 0;
  const options = {
    account,
    ledger,
    provider,
    clock: { now: () => NOW },
    createReservationId: () => `attempt:${String(++index)}`,
    requestId: request.requestId,
    providerInputTokenCeiling: 10,
  };
  return { database, ledger, provider, options, metered: new BudgetedInferenceProvider(options) };
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

export function collectAttempts(test: ReturnType<typeof fixture>, wait: () => Promise<void>) {
  return collect(
    providerStream(
      request,
      {
        provider: test.metered,
        upstreamModel: request.upstreamModel,
      },
      { wait },
      signal(),
    ),
  );
}
