export function invalidUtf8Response(
  text: string,
  marker: string,
  contentType = "application/x-ndjson",
): Response {
  const markerIndex = text.indexOf(marker);
  const prefix = new TextEncoder().encode(text.slice(0, markerIndex));
  const suffix = new TextEncoder().encode(text.slice(markerIndex + marker.length));
  const bytes = new Uint8Array(prefix.byteLength + suffix.byteLength + 1);
  bytes.set(prefix, 0);
  bytes[prefix.byteLength] = 255;
  bytes.set(suffix, prefix.byteLength + 1);
  return new Response(bytes, { headers: { "content-type": contentType } });
}
