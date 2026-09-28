import type { StreamEvent, StreamPort, StreamRequest, TransportContext } from "./contracts.js";

const encoder = new TextEncoder();
export const MAX_STREAM_EVENT_CHARACTERS = 8_192;

const FAILED_EVENT = encoder.encode('{"type":"error","code":"stream_failed"}\n');

type ClosableIterator = AsyncIterator<StreamEvent> &
  Required<Pick<AsyncIterator<StreamEvent>, "return">>;

function encodeEvent(event: StreamEvent): Uint8Array {
  if (event.type === "data" && event.data.length > MAX_STREAM_EVENT_CHARACTERS) {
    throw new RangeError();
  }
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

export function createStreamBody(
  request: StreamRequest,
  principal: TransportContext["principal"],
  port: StreamPort,
  requestSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const execution = new AbortController();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let iterator: AsyncIterator<StreamEvent> | undefined;
  let closeIterator = (): void => {
    // No iterator exists until the first pull.
  };

  const detach = (): void => {
    requestSignal.removeEventListener("abort", abort);
  };

  const finish = (): void => {
    detach();
    controller.close();
  };

  const abort = (): void => {
    execution.abort();
    closeIterator();
    finish();
  };

  return new ReadableStream<Uint8Array>(
    {
      cancel() {
        execution.abort();
        detach();
        closeIterator();
      },
      async pull(receivedController) {
        controller = receivedController;
        try {
          if (iterator === undefined) {
            const iterable = port.stream(request, { principal, signal: execution.signal });
            iterator = iterable[Symbol.asyncIterator]();
            const activeIterator = iterator as ClosableIterator;
            closeIterator = (): void => {
              try {
                const completion = activeIterator.return();
                // Stryker disable next-line ArrowFunction: best-effort cleanup failures are intentionally hidden.
                void completion.catch(() => undefined);
              } catch {
                // Cleanup is optional and cannot delay transport shutdown.
              }
            };
          }
          const next = await iterator.next();
          if (execution.signal.aborted) {
            return;
          }
          if (next.done) {
            finish();
            return;
          }
          receivedController.enqueue(encodeEvent(next.value));
        } catch {
          if (!execution.signal.aborted) {
            receivedController.enqueue(FAILED_EVENT);
            execution.abort();
            closeIterator();
            finish();
          }
        }
      },
      start(receivedController) {
        controller = receivedController;
        if (requestSignal.aborted) {
          receivedController.close();
        } else {
          requestSignal.addEventListener("abort", abort, { once: true });
        }
      },
    },
    { highWaterMark: 0 },
  );
}
