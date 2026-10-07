import type { ProviderModel } from "@marea/plugin-api";
import * as z from "zod";

/** Round USD/token upwards to exact nanodollars, without floating-point multiplication. */
function nanodollars(value: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(value);
  if (match === null || value.length > 64) return null;
  const decimals = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const amount = BigInt(`${String(match[1])}${decimals}`);
  const shift = 9 + exponent - decimals.length;
  const factor = 10n ** BigInt(Math.abs(shift));
  // Stryker disable next-line EqualityOperator: At shift zero, both exact formulas return amount.
  const units = shift >= 0 ? amount * factor : (amount + factor - 1n) / factor;
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : null;
}

export function modelPricing(value: unknown): ProviderModel["pricing"] {
  const parsed = z.object({ prompt: z.string(), completion: z.string() }).safeParse(value);
  if (!parsed.success) return null;
  const input = nanodollars(parsed.data.prompt);
  const output = nanodollars(parsed.data.completion);
  if (input === null || output === null) return null;
  return { costUnit: "nanoUSD", inputCostUnitsPerToken: input, outputCostUnitsPerToken: output };
}
