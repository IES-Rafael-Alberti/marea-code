import assert from "node:assert/strict";
import { TelemetryPreviewResponseSchema, TELEMETRY_PREVIEW_PATH } from "@marea/protocol";

/** Synthetic compiled-host HTTP acceptance; no exporter or provider is configured. */
export async function assertCompiledTelemetryPreview(
  origin: string,
  cookie: string,
): Promise<void> {
  const request = {
    protocolVersion: "0.1",
    requestId: "request:compiled-telemetry",
    kind: "telemetry-preview",
    classId: "class:ready",
  };
  const preview = (body: object, credential: string) =>
    fetch(`${origin}${TELEMETRY_PREVIEW_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        cookie: credential,
      },
      body: JSON.stringify(body),
    });
  const result = await preview(request, cookie);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(result.headers.get("cache-control"), "no-store");
  const text = await result.text();
  const parsed = TelemetryPreviewResponseSchema.parse(JSON.parse(text));
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.destinationCount, 0);
  assert.equal(parsed.synthetic, true);
  assert.equal(parsed.mode, "operational-only");
  assert.equal(parsed.envelope.attributes.length, 2);
  assert.doesNotMatch(text, /student|secret|endpoint|synthetic-sensitive/);
  assert.equal((await preview(request, "")).status, 401);
  assert.equal((await preview({ ...request, classId: "class:foreign" }, cookie)).status, 403);
  assert.equal((await preview({ ...request, enabled: true }, cookie)).status, 400);
}
