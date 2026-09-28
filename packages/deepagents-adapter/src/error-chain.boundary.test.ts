import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { collect, signal } from "./adapter.fixture.js";
import { deepestCause } from "./error-chain.boundary.js";
import {
  failedResponse,
  requestIds,
  runtimeForGateway,
  ScriptedGateway,
} from "./gateway-model.fixture.js";
import { MareaGatewayChatModel } from "./gateway-model.boundary.js";

describe("deepest error cause", () => {
  it("returns a single error itself", () => {
    const error = new Error("boom");
    expect(deepestCause(error)).toBe(error);
  });

  it("returns null for a non-error", () => {
    expect(deepestCause("boom")).toBeNull();
    expect(deepestCause(null)).toBeNull();
  });

  it("terminates on a cyclic chain at its root", () => {
    const cyclic = new Error("loop");
    cyclic.cause = cyclic;
    expect(deepestCause(cyclic)).toBe(cyclic);
  });

  it("finds a typed failure through middleware wrapping", async () => {
    const gateway = new ScriptedGateway(failedResponse());
    const directModel = new MareaGatewayChatModel({ gateway, nextRequestId: requestIds() });
    await expect(directModel.invoke([new HumanMessage("hi")])).rejects.toMatchObject({
      code: "model-stream-failed",
      message: "The Marea model gateway reported a failed stream.",
      name: "ModelStreamError",
      streamCode: "upstream-overloaded",
      streamMessage: "private diagnostic",
      streamRetryable: true,
    });
  });

  it("finds a typed failure in a resumed runtime stream", async () => {
    const gateway = new ScriptedGateway(failedResponse());
    const runtime = runtimeForGateway(gateway);

    let failure: Error | null = null;
    try {
      await collect(
        runtime.streamMessage(
          { messageId: "message:gateway-failure", sessionId: "gateway-failure", text: "hi" },
          signal(),
        ),
      );
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
    expect(failure).toMatchObject({ code: "upstream-execution-failed" });
    expect(deepestCause(failure)).toMatchObject({
      code: "model-stream-failed",
      streamCode: "upstream-overloaded",
      streamMessage: "private diagnostic",
      streamRetryable: true,
    });
  });
});
