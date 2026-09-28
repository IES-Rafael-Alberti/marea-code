import type { AdmissionDenial, TokenUsage, UsagePolicy, UsageTotals } from "./usage-policy.js";

export interface UsageAccount {
  readonly runId: string;
  readonly purpose: "tutoring" | "evaluation";
}

export interface ReserveUsageInput extends UsageAccount {
  readonly reservationId: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly now: string;
}

export type UsageReservation =
  | { readonly admitted: true; readonly reservationId: string; readonly policy: UsagePolicy }
  | { readonly admitted: false; readonly reason: AdmissionDenial | "unconfigured" | "breached" };

export type UsageSettlement = "settled" | "unknown" | "breached";

export interface UsageLedger {
  configure(account: UsageAccount, policy: UsagePolicy, now: string): void;
  reserve(input: ReserveUsageInput): UsageReservation;
  settle(reservationId: string, usage: TokenUsage | null, now: string): UsageSettlement;
  consumeToolCall(reservationId: string, callId: string): boolean;
  recoverUnfinished(now: string): void;
  totals(account: UsageAccount): UsageTotals;
}
