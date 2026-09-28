import {
  InferenceProviderError,
  type InferenceCancellation,
  type InferenceProvider,
  type InferenceProviderEvent,
  type InferenceProviderRequest,
} from "../../packages/plugin-api/src/index.js";

export interface ControlledInference {
  readonly cancellationObserved: Promise<undefined>;
  readonly textEmitted: Promise<undefined>;
  fail(): void;
}

interface ControlledInferenceState {
  readonly failed: Promise<undefined>;
  readonly observeCancellation: () => void;
  readonly observeText: () => void;
  readonly text: string;
}

export class DeterministicInferenceProvider implements InferenceProvider {
  public readonly requests: InferenceProviderRequest[] = [];
  public failNext = false;
  #controlled: ControlledInferenceState | null = null;

  public controlNextAfterText(text: string): ControlledInference {
    if (this.#controlled !== null) {
      throw new Error("A deterministic inference request is already controlled.");
    }
    const emitted = Promise.withResolvers<undefined>();
    const cancelled = Promise.withResolvers<undefined>();
    const failed = Promise.withResolvers<undefined>();
    this.#controlled = {
      failed: failed.promise,
      observeCancellation: () => {
        cancelled.resolve(undefined);
      },
      observeText: () => {
        emitted.resolve(undefined);
      },
      text,
    };
    return Object.freeze({
      cancellationObserved: cancelled.promise,
      fail(): void {
        failed.resolve(undefined);
      },
      textEmitted: emitted.promise,
    });
  }

  public async *stream(
    request: InferenceProviderRequest,
    cancellation: InferenceCancellation,
  ): AsyncIterable<InferenceProviderEvent> {
    await Promise.resolve();
    this.requests.push(request);
    const controlled = this.#controlled;
    if (controlled !== null) {
      this.#controlled = null;
      controlled.observeText();
      yield { text: controlled.text, type: "text-delta" };
      const cancelled = Promise.withResolvers<"cancelled">();
      const observeCancellation = () => {
        controlled.observeCancellation();
        cancelled.resolve("cancelled");
      };
      const unsubscribe = cancellation.subscribe(observeCancellation);
      if (cancellation.aborted) observeCancellation();
      const outcome = await Promise.race([
        controlled.failed.then(() => "failed" as const),
        cancelled.promise,
      ]);
      unsubscribe();
      if (outcome === "cancelled") return;
      throw new InferenceProviderError({
        code: "unavailable",
        message: "synthetic partial provider failure",
        retryable: true,
      });
    }
    if (this.failNext) {
      this.failNext = false;
      throw new InferenceProviderError({
        code: "unavailable",
        message: "synthetic provider unavailable",
        retryable: false,
      });
    }
    const latest = request.messages.at(-1);
    if (latest?.role === "user" && /write|prepare|notes|tide/iu.test(latest.content)) {
      yield { text: "I will prepare the notes. ", type: "text-delta" };
      yield {
        arguments: { content: "The tide is rising.\n", path: "notes/tide.txt" },
        callId: "call-write-file",
        name: "write_file",
        type: "tool-call",
      };
      yield { inputTokens: 8, outputTokens: 4, type: "usage" };
      yield { finishReason: "tool-call", type: "completed" };
      return;
    }
    const content = latest?.role === "tool" ? "The notes are saved." : "I can help with that.";
    yield { text: content, type: "text-delta" };
    yield { inputTokens: 6, outputTokens: 3, type: "usage" };
    yield { finishReason: "stop", type: "completed" };
    if (cancellation.aborted) return;
  }
}
