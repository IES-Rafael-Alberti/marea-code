import { TelemetryExporterError } from "@marea/plugin-api";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TelemetryExporterError("unavailable");
  return value as Record<string, unknown>;
}

function accepted(text: string): void {
  const response = object(JSON.parse(text));
  if (response.partialSuccess == null) return;
  const partial = object(response.partialSuccess);
  const rejected = partial.rejectedDataPoints ?? "0";
  if (rejected !== "0" && rejected !== 0) throw new TelemetryExporterError("unavailable");
  // Warnings with zero rejected points are accepted, but never logged or returned.
}

export async function consumeResponse(response: Response, limit: number): Promise<void> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  const reader = body?.getReader();
  if (!reader) throw new TelemetryExporterError("unavailable");
  try {
    if (Number(response.headers.get("content-length")) > limit)
      throw new TelemetryExporterError("payload-too-large");
    const contentType = response.headers.get("content-type");
    if (response.status !== 200 || contentType === null)
      throw new TelemetryExporterError("unavailable");
    const separator = contentType.indexOf(";");
    const mediaType = separator === -1 ? contentType : contentType.slice(0, separator);
    if (mediaType.trim().toLowerCase() !== "application/json")
      throw new TelemetryExporterError("unavailable");
    const buffer = new Uint8Array(limit);
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > limit)
        throw new TelemetryExporterError("payload-too-large");
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    accepted(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
