import { expect, it } from "vitest";

import {
  collect,
  httpResponse,
  REQUEST,
  sse,
  TestCancellation,
  TestHttp,
  toolCallChunk,
} from "./openrouter.fixture.js";
import { createOpenRouterProviderWith } from "./provider.js";

function streamOf(...chunks: readonly string[]) {
  return createOpenRouterProviderWith(
    { apiKey: "server-secret", endpoint: "https://openrouter.example/api" },
    new TestHttp(httpResponse(sse(...chunks))),
  ).stream(REQUEST, new TestCancellation());
}

const finished = (reason: string) =>
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

it("completes a content-filtered response with a clear message instead of failing", async () => {
  const events = await collect(streamOf(finished("content_filter")));
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: "text-delta" });
  expect(events[0]?.type === "text-delta" ? events[0].text : "").toBe(
    "El proveedor del modelo ha bloqueado esta respuesta con su filtro de contenido. Reformula tu mensaje e inténtalo de nuevo.",
  );
  expect(events[1]).toEqual({ finishReason: "stop", type: "completed" });
});

it("separates the filter notice from text already streamed and drops cut-off tool calls", async () => {
  const events = await collect(
    streamOf(
      JSON.stringify({ choices: [{ index: 0, delta: { content: "Partial" } }] }),
      toolCallChunk({ arguments: "{}", id: "call", name: "write_file" }),
      finished("content_filter"),
    ),
  );
  expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "completed"]);
  expect(events[1]?.type === "text-delta" ? events[1].text : "").toMatch(/^\n\nEl proveedor/u);
});

it("treats a provider error finish as a retryable failure", async () => {
  await expect(collect(streamOf(finished("error")))).rejects.toMatchObject({
    code: "unavailable",
    message: "The inference provider reported an error while answering.",
    retryable: true,
  });
});
