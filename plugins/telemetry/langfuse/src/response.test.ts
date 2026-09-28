import { expect, it } from "vitest";
import { TelemetryExporterError } from "@marea/plugin-api";
import { consumeResponse } from "./response.boundary.js";

it.each([
  "null",
  "[]",
  "1",
  "true",
  '"text"',
  '{"partialSuccess":[]}',
  '{"partialSuccess":1}',
  '{"partialSuccess":true}',
  '{"partialSuccess":"text"}',
  '{"partialSuccess":null}',
])("rejects non-object acknowledgements safely: %s", async (body) => {
  await expect(
    consumeResponse(new Response(body, { headers: { "content-type": "application/json" } }), 1024),
  ).rejects.toEqual(new TelemetryExporterError("unavailable"));
});
it("rejects absent bodies and content type with the closed error vocabulary", async () => {
  await expect(consumeResponse(new Response(null), 1024)).rejects.toEqual(
    new TelemetryExporterError("unavailable"),
  );
  const response = new Response("{}");
  response.headers.delete("content-type");
  await expect(consumeResponse(response, 1024)).rejects.toEqual(
    new TelemetryExporterError("unavailable"),
  );
});
it("accepts whitespace around the JSON media type", async () => {
  await expect(
    consumeResponse(
      new Response("{}", { headers: { "content-type": "application/json ; charset=utf-8" } }),
      2,
    ),
  ).resolves.toBeUndefined();
});
