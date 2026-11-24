import { MAX_JSON_REQUEST_BYTES } from "@marea/protocol";
import { expect, it } from "vitest";
import * as z from "zod";

import { parseJsonRequest } from "./request-json.boundary.js";

const schema = z.object({ value: z.string() }).strict();
const EMPTY_BODY_BYTES = JSON.stringify({ value: "" }).length;

function post(body: string): Request {
  return new Request("https://teacher.example/v1/x", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function bodyOf(size: number): string {
  return JSON.stringify({ value: "x".repeat(size - EMPTY_BODY_BYTES) });
}

it("accepts a plain JSON body of exactly the shared limit", async () => {
  const body = bodyOf(MAX_JSON_REQUEST_BYTES);
  expect(new TextEncoder().encode(body).byteLength).toBe(MAX_JSON_REQUEST_BYTES);
  expect(await parseJsonRequest(post(body), schema)).toEqual({
    ok: true,
    value: { value: "x".repeat(MAX_JSON_REQUEST_BYTES - EMPTY_BODY_BYTES) },
  });
});

it("rejects a plain JSON body one byte over the shared limit with 413", async () => {
  const parsed = await parseJsonRequest(post(bodyOf(MAX_JSON_REQUEST_BYTES + 1)), schema);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.response.status).toBe(413);
});

it("lets a caller raise the limit explicitly", async () => {
  const parsed = await parseJsonRequest(
    post(bodyOf(MAX_JSON_REQUEST_BYTES + 1)),
    schema,
    2 * MAX_JSON_REQUEST_BYTES,
  );
  expect(parsed.ok).toBe(true);
});
