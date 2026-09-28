import { TelemetryExporterError } from "@marea/plugin-api";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ignore unknown protobuf fields; reject malformed or partial acknowledgements safely. */
function acknowledge(text: string): void {
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new TelemetryExporterError("unavailable");
  const partial = value.partialSuccess;
  if (partial === undefined) return;
  if (!record(partial)) throw new TelemetryExporterError("unavailable");
  const rejected = partial.rejectedSpans;
  if (rejected !== undefined && rejected !== 0 && rejected !== "0")
    throw new TelemetryExporterError("unavailable");
  const message = partial.errorMessage;
  if (message !== undefined && typeof message !== "string")
    throw new TelemetryExporterError("unavailable");
  // Zero-rejection warnings are successful acceptance. Never surface their vendor text.
}

export async function consumeResponse(response: Response, limit: number): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new TelemetryExporterError("unavailable");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
        await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new TelemetryExporterError("payload-too-large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (
    response.status !== 200 ||
    String(response.headers.get("content-type")?.split(";")[0]).trim() !== "application/json"
  )
    throw new TelemetryExporterError("unavailable");
  acknowledge(text);
}
