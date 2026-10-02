import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { Clock } from "../identity/contracts.js";
import type { InferenceProviderResolver } from "../product-http/contracts.js";
import { BudgetedInferenceProvider } from "../model-gateway/budgeted-provider.boundary.js";
import { cancellationFor } from "../model-gateway/inference-cancellation.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import type { EducationalRoute } from "./configuration.js";

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
export class EducationalInference {
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
      maxRequests: route.budget.maxRequests,
      maxTokens: route.budget.maxTokens,
      maxCostUnits: route.budget.maxCostUnits,
      costUnit: route.budget.costUnit,
    };
  }
  async generate<T>(
    route: EducationalRoute,
    accountId: string,
    system: string,
    material: object,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const provider = this.providers.resolve(route.providerId);
    if (provider === undefined) throw new Error("unconfigured");
    system += `\nReturn JSON matching: ${JSON.stringify(z.toJSONSchema(schema))}`;
    const text = JSON.stringify(material);
    // Conservative upper bound: UTF-8 bytes cannot undercount supported tokenizer input units.
    if (Buffer.byteLength(system) + Buffer.byteLength(text) > route.inputTokenCeiling)
      throw new Error("input-too-large");
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
        throw new Error("invalid-output");
      if (event.type === "tool-call") throw new Error("invalid-output");
      if (event.type === "text-delta") {
        output += event.text;
        if (Buffer.byteLength(output) > 1048576) throw new Error("invalid-output");
      }
    }
    return schema.parse(JSON.parse(output));
  }
}
