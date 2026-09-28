import {
  InferenceProviderError,
  type InferenceCancellation,
  type InferenceProvider,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "@marea/plugin-api";
import * as z from "zod";

import {
  inferenceFailure,
  InferenceFailure,
  reportInference,
  type InferenceDiagnosticSink,
  type InferenceDiagnostic,
} from "./inference-failure.boundary.js";
import type { ModelGatewayClock } from "./contracts.js";
import { streamWithinDeadline } from "./inference-deadline.boundary.js";
import type {
  UsageAccount,
  UsageLedger,
  UsageReservation,
  UsageSettlement,
} from "./usage-ledger.js";
import {
  admissionDenial,
  TokenUsageSchema,
  type TokenUsage,
  type UsagePolicy,
} from "./usage-policy.js";

export interface BudgetedProviderOptions {
  readonly diagnostic?: InferenceDiagnosticSink | undefined;
  readonly account: UsageAccount;
  readonly ledger: UsageLedger;
  readonly provider: InferenceProvider;
  readonly clock: ModelGatewayClock;
  readonly createReservationId: () => string;
  readonly requestId: string;
  /** Operator-declared full input ceiling of this captured upstream model route. */
  readonly providerInputTokenCeiling: number;
}

function limitFailure(): InferenceFailure {
  return new InferenceFailure("budget-exhausted", "The session has insufficient inference budget.");
}

function invalidUsage(): InferenceFailure {
  return new InferenceFailure("usage-invalid", "The provider did not report valid final usage.");
}

function nextUsage(
  previous: TokenUsage | null,
  event: Extract<InferenceProviderEvent, { type: "usage" }>,
): TokenUsage {
  const parsed = TokenUsageSchema.safeParse({
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
  });
  if (!parsed.success) throw invalidUsage();
  if (
    previous !== null &&
    (parsed.data.inputTokens < previous.inputTokens ||
      parsed.data.outputTokens < previous.outputTokens)
  )
    throw invalidUsage();
  return parsed.data;
}

/** One instance belongs to one logical gateway request; each provider retry reserves again. */
export class BudgetedInferenceProvider implements InferenceProvider {
  private attempt = 0;

  public constructor(private readonly options: BudgetedProviderOptions) {
    z.number().int().positive().parse(options.providerInputTokenCeiling);
  }

  public async *stream(
    request: InferenceProviderRequest,
    cancellation: InferenceCancellation,
  ): AsyncIterable<InferenceProviderEvent> {
    if (request.requestId !== this.options.requestId) throw limitFailure();
    if (cancellation.aborted)
      throw new InferenceProviderError({
        code: "aborted",
        message: "The inference request was cancelled.",
        retryable: false,
      });
    this.attempt += 1;
    const startedAt = this.options.clock.now();
    const reservation = this.options.ledger.reserve({
      ...this.options.account,
      reservationId: this.options.createReservationId(),
      requestId: request.requestId,
      attempt: this.attempt,
      now: startedAt,
    });
    if (!reservation.admitted) this.rejectAdmission(reservation, startedAt);
    // Every path that reports has durably settled; a failed settlement exits before reporting.
    let outcome!: UsageSettlement;
    let code = "completed";
    let emitted = false;
    let retryable = false;
    let retryBlockedBy: string | null = null;
    // This local flag is only read through negation; an absent property is also falsy.
    // Stryker disable next-line ObjectLiteral
    const settlement = { done: false };
    const settle = (usage: TokenUsage | null) => {
      outcome = this.options.ledger.settle(
        reservation.reservationId,
        usage,
        this.options.clock.now(),
      );
      settlement.done = true;
    };
    let usage: TokenUsage | null = null;
    try {
      if (this.options.providerInputTokenCeiling > reservation.policy.maxInputTokens) {
        settle({ inputTokens: 0, outputTokens: 0 });
        throw limitFailure();
      }
      for await (const event of streamWithinDeadline(
        this.options.provider,
        { ...request, maxOutputTokens: reservation.policy.maxOutputTokens },
        cancellation,
        reservation.policy.maxRequestDurationMs,
      )) {
        if (event.type === "usage") {
          usage = this.observeUsage(usage, event, reservation.policy, settle);
        }
        this.checkTool(event, reservation.reservationId);
        if (event.type === "completed") {
          settle(this.finalUsage(usage));
          yield event;
          return;
        }
        if (event.type !== "usage") emitted = true;
        yield event;
      }
      throw invalidUsage();
    } catch (error) {
      if (!settlement.done) settle(null);
      const failure = inferenceFailure(error);
      code = failure.code;
      retryBlockedBy = admissionDenial(
        reservation.policy,
        this.options.ledger.totals(this.options.account),
      );
      retryable = failure.retryable && retryBlockedBy === null;
      if (failure.retryable && !retryable)
        throw new InferenceFailure(failure.code, failure.message);
      throw error;
    } finally {
      if (!settlement.done) {
        settle(null);
        code = "aborted";
      }
      this.report(
        startedAt,
        reservation.policy.maxRequestDurationMs,
        code,
        emitted,
        outcome,
        retryable,
        retryBlockedBy,
      );
    }
  }
  private rejectAdmission(
    reservation: Extract<UsageReservation, { admitted: false }>,
    startedAt: string,
  ): never {
    const concurrency = reservation.reason === "concurrency";
    const failure = concurrency
      ? new InferenceFailure(
          "concurrency-limited",
          "Another inference request is in progress.",
          true,
        )
      : limitFailure();
    this.report(
      startedAt,
      null,
      failure.code,
      false,
      "not-admitted",
      failure.retryable,
      reservation.reason,
    );
    throw failure;
  }

  private checkTool(event: InferenceProviderEvent, reservationId: string): void {
    if (
      event.type === "tool-call" &&
      !this.options.ledger.consumeToolCall(reservationId, event.callId)
    )
      throw limitFailure();
  }

  private finalUsage(usage: TokenUsage | null): TokenUsage {
    if (usage === null) throw invalidUsage();
    return usage;
  }

  private observeUsage(
    previous: TokenUsage | null,
    event: Extract<InferenceProviderEvent, { type: "usage" }>,
    policy: UsagePolicy,
    settle: (usage: TokenUsage) => void,
  ): TokenUsage {
    const usage = nextUsage(previous, event);
    if (usage.inputTokens > policy.maxInputTokens || usage.outputTokens > policy.maxOutputTokens) {
      settle(usage);
      throw limitFailure();
    }
    return usage;
  }

  private report(
    startedAt: string,
    limitMs: number | null,
    code: string,
    emitted: boolean,
    settlement: InferenceDiagnostic["settlement"],
    retryable: boolean,
    retryBlockedBy: string | null,
  ): void {
    const endedAt = this.options.clock.now();
    reportInference(this.options.diagnostic, {
      runId: this.options.account.runId,
      requestId: this.options.requestId,
      attempt: this.attempt,
      startedAt,
      endedAt,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      limitMs,
      code,
      emitted,
      settlement,
      retryable,
      retryBlockedBy,
    });
  }
}
