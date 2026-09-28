/**
 * Reads a response as fatal UTF-8 while bounding every streamed chunk. The
 * reader is cancelled on abort, malformed bytes, and over-limit input before
 * its lock is released.
 */
export async function readGovernanceResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const body = response.body;
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  const cancel = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // Cleanup is best effort; preserve the original transport error.
    }
  };
  const abort = (): void => {
    void cancel();
  };

  signal.addEventListener("abort", abort);
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await cancel();
        throw new RangeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    signal.throwIfAborted();
    return text + decoder.decode();
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function serializeGovernanceRequest(body: object, maxBytes: number): string {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new RangeError();
  }
  return serialized;
}
