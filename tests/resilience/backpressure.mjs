/* global Bun, AbortController, console */
import assert from "node:assert/strict";
import { modelStreamResponse } from "../../apps/teacher-server/src/product-http/model-stream.ts";

// This component probe complements the compiled HTTP slow-reader campaign. It establishes
// the production response's application queue bound, not an OS socket-buffer bound.
let advances = 0;
let finalized = false;
const request = {
  kind: "model-gateway-request",
  protocolVersion: "0.1",
  requestId: "resilience:backpressure",
  modelAlias: "marea",
  messages: [{ role: "student", content: "Synthetic" }],
  tools: [],
};
const gateway = {
  async *stream() {
    try {
      for (let sequence = 0; ; sequence++) {
        advances++;
        yield {
          protocolVersion: "0.1",
          requestId: request.requestId,
          modelAlias: "marea",
          sequence,
          emittedAt: new Date().toISOString(),
          event: "text-delta",
          text: "synthetic",
        };
      }
    } finally {
      finalized = true;
    }
  },
};
const response = modelStreamResponse(gateway, request, new AbortController().signal);
await Bun.sleep(100);
assert.equal(advances, 1, "Unconsumed response must not drain the upstream iterator");
const reader = response.body.getReader();
assert.equal((await reader.read()).done, false);
await Bun.sleep(100);
assert.equal(advances, 2, "One consumed chunk permits only one replacement chunk");
await reader.cancel();
assert.equal(finalized, true, "Cancellation must return the upstream iterator");
await Bun.sleep(100);
assert.equal(advances, 2, "Cancelled response must not advance upstream");
console.log(
  "Production response application queue: one chunk; cancellation returns iterator; pass",
);
