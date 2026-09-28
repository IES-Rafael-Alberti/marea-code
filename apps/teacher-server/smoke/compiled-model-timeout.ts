import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelGatewayRequestSchema, type ModelGatewayStreamChunk } from "@marea/protocol";

import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";
import { modelStreamResponse } from "../src/product-http/model-stream.js";
import { compileExecutable } from "./compile-executable.js";

async function delayedStream(): Promise<void> {
  const request = ModelGatewayRequestSchema.parse({
    kind: "model-gateway-request",
    protocolVersion: "0.1",
    requestId: "request:slow-model",
    modelAlias: "marea",
    messages: [{ role: "student", content: "Synthetic request" }],
    tools: [],
  });
  const base = {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    modelAlias: request.modelAlias,
    emittedAt: "2026-09-19T00:00:00.000Z",
  };
  const chunks: readonly ModelGatewayStreamChunk[] = [
    { ...base, event: "started", sequence: 0 },
    { ...base, event: "text-delta", sequence: 1, delta: "Synthetic delayed response" },
  ];
  const server = bunServe({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (incoming) =>
      Promise.resolve(
        modelStreamResponse(
          {
            async *stream() {
              for (const chunk of chunks) {
                // Exercise silence before the first byte and between streamed chunks.
                await Bun.sleep(12_000);
                yield chunk;
              }
            },
          },
          request,
          incoming.signal,
        ),
      ),
  });
  try {
    const response = await fetch(`${server.url}/v1/model/stream`, {
      method: "POST",
      signal: AbortSignal.timeout(40_000),
    });
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      chunks.map((chunk) => JSON.stringify(chunk) + "\n").join(""),
    );
  } finally {
    await server.stop();
  }
}

if (process.argv.includes("--compiled")) {
  await delayedStream();
  process.stdout.write("Compiled model idle-timeout regression: pass\n");
} else {
  const root = mkdtempSync(join(tmpdir(), "marea-model-timeout-"));
  try {
    const executable = join(root, "probe");
    compileExecutable("smoke/compiled-model-timeout.ts", executable);
    const result = spawnSync(executable, ["--compiled"], { encoding: "utf8", timeout: 45_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "Compiled model idle-timeout regression: pass\n");
    process.stdout.write(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
