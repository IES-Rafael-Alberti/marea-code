import { InferenceProviderError } from "@marea/plugin-api";

const MAX_SSE_LINE_BYTES = 1_048_576;

function invalidStream(): never {
  throw new InferenceProviderError({
    code: "invalid-response",
    message: "The inference provider returned an invalid stream.",
    retryable: false,
  });
}

function parseDataLine(line: string): string | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }
  return line.slice(5).trimStart();
}

export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      buffered += decoder.decode(result.value, { stream: true });
      const lines = buffered.split(/\r?\n/u);
      // Stryker disable next-line all: String.split always yields at least one segment.
      /* v8 ignore next */
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const data = parseDataLine(line);
        if (data !== undefined) {
          yield data;
        }
      }
      if (new TextEncoder().encode(buffered).byteLength > MAX_SSE_LINE_BYTES) {
        invalidStream();
      }
    }
    buffered += decoder.decode();
    const data = parseDataLine(buffered);
    if (data !== undefined) {
      yield data;
    }
  } finally {
    reader.releaseLock();
  }
}
