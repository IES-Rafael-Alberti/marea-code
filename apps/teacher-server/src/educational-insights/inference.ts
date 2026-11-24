import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { Clock } from "../identity/contracts.js";
import type { InferenceProviderResolver } from "../product-http/contracts.js";
import { BudgetedInferenceProvider } from "../model-gateway/budgeted-provider.boundary.js";
import { cancellationFor } from "../model-gateway/inference-cancellation.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import type { EducationalRoute } from "./configuration.js";
import { classifyFailure, InsightsFailure, parseModelOutput } from "./model-output.boundary.js";

/** A separate durable ledger prevents dashboard analysis from consuming student budgets. */
function educationalLedger(database: SqliteApplicationDatabase) {
  const sql = (query: string) => query.replaceAll("marea_usage_", "marea_educational_usage_");
  return new SqliteUsageLedger({
    execute: (query, values) => {
      database.execute(sql(query), values);
    },
    readOne: (query, values) => database.readOne(sql(query), values),
    transaction: (work) => database.transaction(work),
  });
}
interface ModelCall {
  readonly budgeted: BudgetedInferenceProvider;
  readonly requestId: string;
  readonly route: EducationalRoute;
}
/** Every model call, including a repair or transient retry, is bounded by this deadline. */
export const MODEL_CALL_DEADLINE_MS = 300_000;
export class EducationalInference {
  /** Mutable so tests can shorten the bounds without fake timers. */
  deadlineMs = MODEL_CALL_DEADLINE_MS;
  retryDelayMs = 1000;
  readonly ledger;
  constructor(
    database: SqliteApplicationDatabase,
    readonly providers: InferenceProviderResolver,
    readonly clock: Clock,
  ) {
    this.ledger = educationalLedger(database);
  }
  usage(accountId: string, route: EducationalRoute | undefined) {
    if (route === undefined) return null;
    return {
      ...this.ledger.totals({ runId: accountId, purpose: "evaluation" }),
      maxRequests: route.budget.unlimited === true ? null : route.budget.maxRequests,
      maxTokens: route.budget.unlimited === true ? null : route.budget.maxTokens,
      maxCostUnits: route.budget.unlimited === true ? null : route.budget.maxCostUnits,
      costUnit: route.budget.costUnit,
    };
  }
  /**
   * Parses tolerant JSON output, repairs it once from the validation error, bounds every call by
   * a deadline even for unlimited budgets, and retries one transient provider failure.
   */
  async generate<T>(
    route: EducationalRoute,
    accountId: string,
    system: string,
    material: object,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    /** The strict shape described to the model; `schema` may be more tolerant than it. */
    contract: z.ZodType = schema,
  ): Promise<T> {
    const provider = this.providers.resolve(route.providerId);
    if (provider === undefined) throw new InsightsFailure("unconfigured");
    system += `\nReturn JSON matching: ${JSON.stringify(z.toJSONSchema(contract))}`;
    const text = JSON.stringify(material);
    const account = { runId: accountId, purpose: "evaluation" as const };
    this.ledger.configure(account, route.budget, this.clock.now());
    const requestId = randomUUID();
    const budgeted = new BudgetedInferenceProvider({
      account,
      ledger: this.ledger,
      provider,
      clock: this.clock,
      createReservationId: randomUUID,
      requestId,
      providerInputTokenCeiling: route.inputTokenCeiling,
    });
    let prompt = system;
    for (let attempt = 0; ; attempt++) {
      const output = await this.complete({ budgeted, requestId, route }, prompt, text, signal);
      const parsed = parseModelOutput(output, schema);
      if (parsed.ok) return parsed.value;
      if (attempt === 1) throw new InsightsFailure("output-invalid");
      prompt = `${system}\nYour previous answer was rejected: ${parsed.reason}. Return only one corrected JSON object.`;
    }
  }
  private async complete(
    call: ModelCall,
    system: string,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    // Conservative upper bound: UTF-8 bytes cannot undercount supported tokenizer input units.
    if (
      call.route.budget.unlimited !== true &&
      Buffer.byteLength(system) + Buffer.byteLength(text) > call.route.inputTokenCeiling
    )
      throw new InsightsFailure("input-too-large");
    const limit = new AbortController();
    const timer = setTimeout(() => {
      limit.abort();
    }, this.deadlineMs);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.collect(call, system, text, AbortSignal.any([signal, limit.signal]));
        } catch (error) {
          if (signal.aborted) throw error;
          if (limit.signal.aborted) throw new InsightsFailure("deadline");
          const { failure, transient } = classifyFailure(error);
          if (!transient || attempt === 1) throw failure;
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
  private async collect(
    { budgeted, requestId, route }: ModelCall,
    system: string,
    text: string,
    signal: AbortSignal,
  ): Promise<string> {
    let output = "";
    for await (const event of budgeted.stream(
      {
        requestId,
        upstreamModel: route.model,
        tools: [],
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
      },
      cancellationFor(signal),
    )) {
      if (event.type === "completed" && event.finishReason !== "stop")
        throw new InsightsFailure("output-invalid");
      if (event.type === "tool-call") throw new InsightsFailure("output-invalid");
      if (event.type === "text-delta") {
        output += event.text;
        if (Buffer.byteLength(output) > 1048576) throw new InsightsFailure("output-invalid");
      }
    }
    return output;
  }
}
