/**
 * Read a dashboard response without buffering an unbounded body or accepting
 * replacement characters for malformed UTF-8.
 */
export function serializeSkillAuthoringRequest(body: object, maxBytes: number): string {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new RangeError("Skill authoring request byte limit exceeded.");
  }
  return serialized;
}

export async function readSkillAuthoringResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const body = response.body;
  if (body === null) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort);
  let bytes = 0;
  let text = "";

  try {
    let next = await reader.read();
    while (!next.done) {
      bytes = await countResponseBytes(bytes, next.value.byteLength, maxBytes, () =>
        reader.cancel(),
      );
      text += decoder.decode(next.value, { stream: true });
      next = await reader.read();
    }
    signal.throwIfAborted();
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function countResponseBytes(
  current: number,
  added: number,
  maximum: number,
  cancel: () => Promise<void>,
): Promise<number> {
  const total = current + added;
  if (total > maximum) {
    await cancel();
    throw new RangeError("Skill authoring response byte limit exceeded.");
  }
  return total;
}
