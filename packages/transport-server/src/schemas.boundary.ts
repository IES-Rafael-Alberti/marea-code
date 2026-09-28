import * as z from "zod";

import { MAX_INPUT_CHARACTERS, type ClientFrame, type StreamRequest } from "./contracts.js";

type ParseResult<T> = { readonly ok: false } | { readonly ok: true; readonly value: T };

function identifierSchema(): z.ZodString {
  return z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u);
}

function inputSchema(): z.ZodString {
  return z.string().min(1).max(MAX_INPUT_CHARACTERS);
}

function streamRequestSchema(): z.ZodType<StreamRequest> {
  return z.strictObject({
    input: inputSchema(),
    streamId: identifierSchema(),
  });
}

function clientFrameSchema(): z.ZodType<ClientFrame> {
  return z.strictObject({
    input: inputSchema(),
    messageId: identifierSchema(),
    type: z.literal("message"),
  });
}

function parse<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  try {
    // This assertion stays inside the boundary and is immediately checked by Zod.
    const value = JSON.parse(text) as object;
    const result = schema.safeParse(value);
    return result.success ? { ok: true, value: result.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function parseStreamRequest(text: string): ParseResult<StreamRequest> {
  return parse(text, streamRequestSchema());
}

export function parseClientFrame(text: string): ParseResult<ClientFrame> {
  return parse(text, clientFrameSchema());
}
