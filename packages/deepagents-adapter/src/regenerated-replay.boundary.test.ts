import { describe, expect, it } from "vitest";

import { captureAdapterFailure, collect, signal } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import {
  midStreamInvalidResponse,
  publicWriteResponse,
  requestIds,
  ScriptedGateway,
  textResponse,
} from "./gateway-model.fixture.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

/**
 * Field report (preview 48): OpenRouter + DeepSeek fails with `invalid-response` after part of
 * the answer was streamed; the student TUI retries the same message automatically, the model
 * regenerates the answer with different words, and the adapter refuses the turn with
 * `invalid-replay-prefix` because the regenerated text does not start with the shown partial.
 */

function runtimeFor(gateway: ScriptedGateway) {
  return createAgentRuntime({
    approvalTool: {
      name: "unused_tool",
      description: "Unused synthetic tool.",
      execute: () => Promise.resolve("unused"),
    },
    checkpoint: createInMemoryCheckpointForTest(),
    model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
    systemPrompt: "Teach clearly.",
  });
}

const SHOWN = "Primero, revisa el bucle";
const REGENERATED = "Vale, empecemos por la condición del while.";
const QUESTION = "¿Por qué no para?";

function failedTurn(sessionId: string) {
  return { assistantText: SHOWN, messageId: "message:failed", sessionId, text: QUESTION };
}

async function failOnce(runtime: ReturnType<typeof runtimeFor>, sessionId: string) {
  const failed = await captureAdapterFailure(
    runtime.streamMessage({ ...failedTurn(sessionId), assistantText: "" }, signal()),
  );
  expect(failed).toMatchObject({
    events: [{ type: "assistant-text-delta", text: SHOWN }],
    error: { code: "upstream-execution-failed" },
  });
}

/** The retried message drops the shown partial, then streams the regenerated answer. */
async function expectRegenerated(runtime: ReturnType<typeof runtimeFor>, sessionId: string) {
  await expect(collect(runtime.streamMessage(failedTurn(sessionId), signal()))).resolves.toEqual([
    { type: "assistant-text-restarted", discardedLength: SHOWN.length },
    { type: "assistant-text-delta", text: REGENERATED },
    { type: "turn-completed" },
  ]);
}

describe("automatic retry after a mid-stream provider failure (field reproduction)", () => {
  it("completes the same message when the model regenerates a different answer", async () => {
    const gateway = new ScriptedGateway(midStreamInvalidResponse(SHOWN), textResponse(REGENERATED));
    const runtime = runtimeFor(gateway);
    await failOnce(runtime, "field-replay");

    // The automatic retry (student-tui AutomaticRetries) resends the same message with the
    // text the student session persisted for it.
    await expectRegenerated(runtime, "field-replay");
    expect(gateway.requests).toHaveLength(2);
  });

  it("recovers a caller that never applied the discard of a completed regeneration", async () => {
    const gateway = new ScriptedGateway(midStreamInvalidResponse(SHOWN), textResponse(REGENERATED));
    const runtime = runtimeFor(gateway);
    await failOnce(runtime, "field-replay-stale");
    await collect(runtime.streamMessage(failedTurn("field-replay-stale"), signal()));
    await expectRegenerated(runtime, "field-replay-stale");
    expect(gateway.requests).toHaveLength(2);
  });

  it("accepts the superseded text after a stop between the journal discard and the caller's", async () => {
    const gateway = new ScriptedGateway(midStreamInvalidResponse(SHOWN), textResponse(REGENERATED));
    const runtime = runtimeFor(gateway);
    await failOnce(runtime, "field-replay-crash");
    const interrupted = runtime.streamMessage(failedTurn("field-replay-crash"), signal());
    const iterator = interrupted[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "assistant-text-restarted", discardedLength: SHOWN.length },
    });
    // The process stops here: the journal discarded the partial, the caller did not.
    await iterator.return?.(undefined);
    expect(gateway.requests).toHaveLength(1);

    await expectRegenerated(runtime, "field-replay-crash");
  });

  it("still refuses text the durable turn never held", async () => {
    const gateway = new ScriptedGateway(midStreamInvalidResponse(SHOWN));
    const runtime = runtimeFor(gateway);
    await failOnce(runtime, "field-replay-foreign");
    await expect(
      collect(
        runtime.streamMessage(
          { ...failedTurn("field-replay-foreign"), assistantText: "Otra cosa" },
          signal(),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid-replay-prefix" });
    expect(gateway.requests).toHaveLength(1);
  });

  it("keeps the failed question in the next message's context without its partial answer", async () => {
    const gateway = new ScriptedGateway(
      textResponse("Hola."),
      midStreamInvalidResponse(SHOWN),
      textResponse("Siguiente."),
      textResponse("Y otra."),
    );
    const runtime = runtimeFor(gateway);
    const sessionId = "field-replay-next";
    await collect(
      runtime.streamMessage({ messageId: "message:first", sessionId, text: "Hola" }, signal()),
    );
    await failOnce(runtime, sessionId);
    await expect(
      collect(
        runtime.streamMessage({ messageId: "message:next", sessionId, text: "Otra" }, signal()),
      ),
    ).resolves.toContainEqual({ type: "turn-completed" });
    const next = gateway.requests.at(-1)?.messages ?? [];
    expect(next.filter((message) => message.role === "student").map((m) => m.content)).toEqual([
      "Hola",
      QUESTION,
      "Otra",
    ]);
    expect(JSON.stringify(next)).not.toContain(SHOWN);
    // Once answered, the question is part of the history and is not carried again.
    await collect(
      runtime.streamMessage({ messageId: "message:last", sessionId, text: "Fin" }, signal()),
    );
    expect(
      gateway.requests
        .at(-1)
        ?.messages.filter((message) => message.role === "student")
        .map((m) => m.content),
    ).toEqual(["Hola", QUESTION, "Otra", "Fin"]);
  });

  it("carries only questions of the same session", async () => {
    const gateway = new ScriptedGateway(midStreamInvalidResponse(SHOWN), textResponse("Hola."));
    const runtime = runtimeFor(gateway);
    await failOnce(runtime, "field-replay-other");
    await collect(
      runtime.streamMessage(
        { messageId: "message:first", sessionId: "field-replay-own", text: "Hola" },
        signal(),
      ),
    );
    expect(
      gateway.requests[1]?.messages
        .filter((message) => message.role === "student")
        .map((message) => message.content),
    ).toEqual(["Hola"]);
  });

  it("starts fresh after an abandoned approval, keeping only its question", async () => {
    const gateway = new ScriptedGateway(publicWriteResponse(), textResponse("Vale."));
    const runtime = createAgentRuntime({
      approvalTool: {
        name: "marea_write_file",
        description: "Write approved text content to a student file.",
        execute: () => Promise.resolve("written"),
      },
      checkpoint: createInMemoryCheckpointForTest(),
      model: createMareaGatewayModel({ gateway, nextRequestId: requestIds() }),
      systemPrompt: "Teach clearly.",
    });
    const sessionId = "field-replay-abandoned";
    await collect(
      runtime.streamMessage({ messageId: "message:save", sessionId, text: "Guarda" }, signal()),
    );
    await collect(
      runtime.streamMessage({ messageId: "message:after", sessionId, text: "Otra" }, signal()),
    );
    expect(gateway.requests[1]?.messages.filter((message) => message.role !== "system")).toEqual([
      { role: "student", content: "Guarda" },
      { role: "student", content: "Otra" },
    ]);
  });
});
