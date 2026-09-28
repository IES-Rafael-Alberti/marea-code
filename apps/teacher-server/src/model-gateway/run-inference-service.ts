import type { InferenceDiagnosticSink } from "./inference-failure.boundary.js";
import type { InferenceProvider } from "@marea/plugin-api";

import type { AuthorizedRunLease } from "../sessions/contracts.js";
import { BudgetedInferenceProvider } from "./budgeted-provider.boundary.js";
import type { ModelGatewayClock } from "./contracts.js";
import type { UsageLedger } from "./usage-ledger.js";

export class RunInferenceService {
  public constructor(
    private readonly options: {
      readonly diagnostic?: InferenceDiagnosticSink | undefined;
      readonly ledger: UsageLedger;
      readonly clock: ModelGatewayClock;
      readonly createReservationId: () => string;
    },
  ) {}

  public providerFor(
    lease: AuthorizedRunLease,
    requestId: string,
    provider: InferenceProvider,
  ): InferenceProvider | null {
    const budget = lease.providerRoute.budget;
    if (budget === undefined) return null;
    const account = { runId: lease.runId, purpose: "tutoring" as const };
    this.options.ledger.configure(account, budget.tutoring, this.options.clock.now());
    return new BudgetedInferenceProvider({
      account,
      diagnostic: this.options.diagnostic,
      ledger: this.options.ledger,
      provider,
      clock: this.options.clock,
      createReservationId: this.options.createReservationId,
      requestId,
      providerInputTokenCeiling: budget.inputTokenCeiling,
    });
  }
}
