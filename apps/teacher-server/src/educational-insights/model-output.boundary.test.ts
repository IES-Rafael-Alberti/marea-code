import { describe, expect, it } from "vitest";
import * as z from "zod";
import { InferenceProviderError } from "@marea/plugin-api";
import { InferenceFailure } from "../model-gateway/inference-failure.boundary.js";
import {
  classifyFailure,
  extractJson,
  InsightsFailure,
  parseModelOutput,
} from "./model-output.boundary.js";

describe("extractJson", () => {
  it.each([
    ["plain JSON", '{"a":1}', { a: 1 }],
    ["surrounding whitespace", '  \n{"a":1}\n ', { a: 1 }],
    ["a json fence", '```json\n{"a":1}\n```', { a: 1 }],
    ["an unlabelled fence", '```\n{"a":1}\n```', { a: 1 }],
    ["a fence surrounded by prose", 'Here:\n```json\n{"a":[1,2]}\n```\nDone.', { a: [1, 2] }],
    ["an object inside prose", 'Sure! {"a":{"b":2}} hope it helps', { a: { b: 2 } }],
    ["braces inside strings", 'x {"a":"}{ \\" }"} y', { a: '}{ " }' }],
    ["prose inside a fence", '```json\nResult: {"a":3} ok\n```', { a: 3 }],
    ["an escaped backslash before a quote", 'x {"a":"\\\\"} y', { a: "\\" }],
    ["a bare array", "[1,2]", [1, 2]],
  ])("accepts %s", (_label, output, value) => {
    expect(extractJson(output)).toEqual({ value });
  });
  it.each([
    ["no JSON at all", "I cannot help"],
    ["an unterminated object", '{"a":1'],
    ["an unterminated string", '{"a":"x}'],
    ["an invalid object", "{a:1}"],
    ["an empty output", ""],
  ])("rejects %s", (_label, output) => {
    expect(extractJson(output)).toBeUndefined();
  });
  it("prefers the whole text, then the fence, then the first object", () => {
    expect(extractJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(extractJson('{"a":1} ```json\n{"a":2}\n```')).toEqual({ value: { a: 2 } });
    expect(extractJson('{bad} ```json\n{"a":2}\n```')).toEqual({ value: { a: 2 } });
    expect(extractJson('```\nnope\n``` {"a":4}')).toEqual({ value: { a: 4 } });
    expect(extractJson('{bad} {"a":3}')).toBeUndefined();
  });
});

describe("parseModelOutput", () => {
  const schema = z.object({ a: z.number(), b: z.object({ c: z.string() }) });
  it("returns the parsed value", () => {
    expect(parseModelOutput('```json\n{"a":1,"b":{"c":"x"}}\n```', schema)).toEqual({
      ok: true,
      value: { a: 1, b: { c: "x" } },
    });
  });
  it("explains a missing object", () => {
    expect(parseModelOutput("nothing", schema)).toEqual({
      ok: false,
      reason: "the answer was not a JSON object",
    });
  });
  it("lists issues with their path, naming the root", () => {
    const parsed = parseModelOutput('{"a":"x","b":{}}', schema);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toBe(
      "a: Invalid input: expected number, received string; b.c: Invalid input: expected string, received undefined",
    );
    const root = parseModelOutput("[1]", schema);
    expect(root.ok ? "" : root.reason).toBe(
      "(root): Invalid input: expected object, received array",
    );
  });
  it("bounds the description to eight issues and one thousand characters", () => {
    const many = z.object(
      Object.fromEntries(Array.from({ length: 12 }, (_v, i) => [`k${String(i)}`, z.number()])),
    );
    const reason = parseModelOutput("{}", many);
    expect(reason.ok ? "" : reason.reason.split("; ")).toHaveLength(8);
    const long = z.object({ [`k${"x".repeat(2000)}`]: z.number() });
    const clipped = parseModelOutput("{}", long);
    expect(clipped.ok ? "" : clipped.reason).toHaveLength(1000);
  });
});

describe("classifyFailure", () => {
  const provider = (code: InferenceProviderError["code"], retryable: boolean) =>
    new InferenceProviderError({ code, message: "m", retryable });
  it.each([
    [new InsightsFailure("deadline"), "deadline", false],
    [new InferenceFailure("budget-exhausted", "m", true), "budget", false],
    [new InferenceFailure("deadline-exceeded", "m", true), "deadline", false],
    [new InferenceFailure("concurrency-limited", "m", true), "provider", true],
    [new InferenceFailure("usage-invalid", "m"), "provider", false],
    [provider("rate-limited", true), "provider", true],
    [provider("unavailable", false), "provider", false],
    [provider("context-exceeded", false), "input-too-large", false],
    [provider("context-unavailable", true), "input-too-large", true],
    [new Error("other"), "provider", false],
    ["text", "provider", false],
  ])("classifies %#", (error, code, transient) => {
    const { failure, transient: retry } = classifyFailure(error);
    expect(failure).toBeInstanceOf(InsightsFailure);
    expect(failure.code).toBe(code);
    expect(failure.message).toBe(code);
    expect(retry).toBe(transient);
  });
  it("keeps the identity of an insights failure", () => {
    const failure = new InsightsFailure("output-invalid");
    expect(classifyFailure(failure).failure).toBe(failure);
    expect(failure.name).toBe("InsightsFailure");
  });
});
