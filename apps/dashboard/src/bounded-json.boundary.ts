/** Reads at most `limit` bytes of strict UTF-8 JSON and always releases the stream. */
export async function readBoundedJson(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("Dashboard response too large.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return JSON.parse(text);
}
