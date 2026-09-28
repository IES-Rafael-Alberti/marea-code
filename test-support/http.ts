import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

function requestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  // The policy is intentionally checked against the canonical loopback host; the real port is
  // selected after listen() and is not part of the application authority contract.
  headers.set("host", "127.0.0.1");
  return headers;
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  target.writeHead(response.status, headers);
  const body = response.body;
  if (body === null) {
    target.end();
    return;
  }
  const reader = body.getReader();
  try {
    let done = false;
    while (!done) {
      const next = await reader.read();
      if (next.done) done = true;
      else target.write(Buffer.from(next.value));
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

export interface ResponseLossRule {
  readonly path: string;
  readonly matches?: (body: string) => boolean;
}

export interface HeldHttpResponse {
  readonly reached: Promise<undefined>;
  readonly requestAborted: Promise<undefined>;
  release(): void;
}

interface HeldHttpResponseState {
  readonly observeAbort: () => void;
  readonly observeReached: () => void;
  readonly release: () => void;
  readonly released: Promise<undefined>;
  readonly rule: ResponseLossRule;
}

export interface LoopbackHttpServer {
  readonly baseUrl: string;
  holdNextResponse(rule: ResponseLossRule): HeldHttpResponse;
  loseNextResponse(rule: ResponseLossRule): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function createLoopbackHttpServer(application: {
  fetch(request: Request): Response | Promise<Response>;
}): Promise<LoopbackHttpServer> {
  let loss: ResponseLossRule | null = null;
  let held: HeldHttpResponseState | null = null;
  const nodeServer = createServer((request, response) => {
    void (async () => {
      const transportAbort = new AbortController();
      request.once("aborted", () => {
        transportAbort.abort();
      });
      response.once("close", () => {
        if (!response.writableEnded) transportAbort.abort();
      });
      const body = await requestBody(request);
      const input = new Request(`http://127.0.0.1${request.url ?? "/"}`, {
        body: body.byteLength === 0 ? undefined : body,
        duplex: "half",
        headers: requestHeaders(request),
        method: request.method ?? "GET",
        signal: transportAbort.signal,
      } as RequestInit & { readonly duplex: "half" });
      const output = await application.fetch(input);
      const rule = loss;
      if (rule !== null && rule.path === new URL(input.url).pathname) {
        const matches = rule.matches?.(body.toString("utf8")) ?? true;
        if (matches) {
          loss = null;
          response.destroy();
          return;
        }
      }
      const heldResponse = held;
      if (heldResponse !== null && heldResponse.rule.path === new URL(input.url).pathname) {
        const matches = heldResponse.rule.matches?.(body.toString("utf8")) ?? true;
        if (matches) {
          held = null;
          const observeAbort = () => {
            heldResponse.observeAbort();
          };
          transportAbort.signal.addEventListener("abort", observeAbort, { once: true });
          if (transportAbort.signal.aborted) observeAbort();
          heldResponse.observeReached();
          await heldResponse.released;
          transportAbort.signal.removeEventListener("abort", observeAbort);
        }
      }
      await writeResponse(output, response);
    })().catch(() => {
      if (!response.writableEnded) response.destroy();
    });
  });

  const listen = (port: number): Promise<void> =>
    nodeServer.listening
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          const onError = (error: Error) => {
            reject(error);
          };
          nodeServer.once("error", onError);
          nodeServer.listen(port, "127.0.0.1", () => {
            nodeServer.off("error", onError);
            resolve();
          });
        });
  const stop = (): Promise<void> => {
    held?.release();
    held = null;
    return nodeServer.listening
      ? new Promise((resolve, reject) => {
          nodeServer.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        })
      : Promise.resolve();
  };

  await listen(0);
  const address = nodeServer.address();
  if (address === null || typeof address === "string") {
    nodeServer.close();
    throw new Error("The acceptance HTTP server did not expose a TCP address.");
  }
  const port = address.port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    holdNextResponse(rule: ResponseLossRule): HeldHttpResponse {
      if (held !== null) throw new Error("An acceptance HTTP response is already held.");
      const reached = Promise.withResolvers<undefined>();
      const requestAborted = Promise.withResolvers<undefined>();
      const released = Promise.withResolvers<undefined>();
      held = {
        observeAbort: () => {
          requestAborted.resolve(undefined);
        },
        observeReached: () => {
          reached.resolve(undefined);
        },
        release: () => {
          released.resolve(undefined);
        },
        released: released.promise,
        rule,
      };
      return Object.freeze({
        reached: reached.promise,
        release(): void {
          released.resolve(undefined);
        },
        requestAborted: requestAborted.promise,
      });
    },
    loseNextResponse(rule: ResponseLossRule): void {
      loss = rule;
    },
    start: () => listen(port),
    stop,
    close: stop,
  };
}
