import { InferenceProviderError } from "@marea/plugin-api";
import type * as z from "zod";
import { InferenceFailure } from "../model-gateway/inference-failure.boundary.js";

/** Closed, content-free causes of a failed educational model call. */
export type InsightsFailureCode =
  "unconfigured" | "input-too-large" | "output-invalid" | "budget" | "provider" | "deadline";

export class InsightsFailure extends Error {
  constructor(readonly code: InsightsFailureCode) {
    super(code);
    this.name = "InsightsFailure";
  }
}

/** The first balanced top-level JSON object in prose, aware of strings and escapes. */
function firstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  // Stryker disable next-line ConditionalExpression: without a brace the scan finds nothing anyway.
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  // Stryker disable next-line EqualityOperator: charAt past the end is an empty string.
  for (let index = start; index < text.length; index++) {
    const character = text.charAt(index);
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

// Stryker disable BlockStatement: an empty catch block also yields undefined.
function parseJson(text: string | undefined): { readonly value: unknown } | undefined {
  // Stryker disable next-line ConditionalExpression: parsing undefined throws and is caught below.
  if (text === undefined) return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

// Stryker restore BlockStatement
/** Models often wrap JSON in a code fence or prose; accept the first parseable form. */
export function extractJson(output: string): { readonly value: unknown } | undefined {
  const text = output;
  const fenced = /```[A-Za-z]*([\s\S]*?)```/u.exec(text)?.[1];
  return (
    parseJson(text) ??
    parseJson(fenced) ??
    parseJson(firstObject(fenced ?? text)) ??
    parseJson(firstObject(text))
  );
}

/** A bounded, content-free description of why output was rejected, for one repair attempt. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
    .slice(0, 1000);
}

export type ParsedOutput<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export function parseModelOutput<T>(output: string, schema: z.ZodType<T>): ParsedOutput<T> {
  const json = extractJson(output);
  if (json === undefined) return { ok: false, reason: "the answer was not a JSON object" };
  const parsed = schema.safeParse(json.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: describeIssues(parsed.error) };
}

/** Maps any gateway or provider failure to a closed code and whether one retry may help. */
export function classifyFailure(error: unknown): {
  readonly failure: InsightsFailure;
  readonly transient: boolean;
} {
  if (error instanceof InsightsFailure) return { failure: error, transient: false };
  if (error instanceof InferenceFailure) {
    if (error.code === "budget-exhausted")
      return { failure: new InsightsFailure("budget"), transient: false };
    if (error.code === "deadline-exceeded")
      return { failure: new InsightsFailure("deadline"), transient: false };
    return { failure: new InsightsFailure("provider"), transient: error.retryable };
  }
  if (error instanceof InferenceProviderError) {
    const oversized = error.code === "context-exceeded" || error.code === "context-unavailable";
    return {
      failure: new InsightsFailure(oversized ? "input-too-large" : "provider"),
      transient: error.retryable,
    };
  }
  return { failure: new InsightsFailure("provider"), transient: false };
}
