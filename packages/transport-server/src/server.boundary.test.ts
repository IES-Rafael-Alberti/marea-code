import { describe, expect, it, vi } from "vitest";
import { createWSMessageEvent, WSContext } from "hono/ws";

import {
  MAX_REQUEST_BYTES,
  type AuthenticationPort,
  type SessionPort,
  type StreamPort,
  type TransportServerOptions,
} from "./contracts.js";
import type { BunSocketData, BunUpgradeEnvironment } from "./bun-websocket.boundary.js";
import { createBunTransport } from "./server.boundary.js";

const endpoint = "http://example.test:8443/stream";
const requestBody = JSON.stringify({ input: "Help", streamId: "stream_1" });

interface PortOverrides {
  readonly authentication?: AuthenticationPort;
  readonly sessions?: SessionPort;
  readonly streams?: StreamPort;
}

function options(overrides: PortOverrides = {}): TransportServerOptions {
  return {
    mounts: { session: "/session", stream: "/stream" },
    policy: {
      allowedHosts: ["example.test:8443"],
      allowedOrigins: ["https://teacher.example"],
    },
    ports: {
      authentication: overrides.authentication ?? {
        authenticate() {
          return Promise.resolve({
            authenticated: true as const,
            principal: { id: "teacher-1" },
          });
        },
      },
      sessions: overrides.sessions ?? {
        handle() {
          return Promise.resolve();
        },
      },
      streams: overrides.streams ?? {
        async *stream() {
          await Promise.resolve();
          yield { data: "Hello", type: "data" } as const;
          yield { type: "end" } as const;
        },
      },
    },
  };
}

function headers(extra: HeadersInit = {}): Headers {
  const result = new Headers({
    authorization: "Bearer valid-token",
    "content-type": "application/json",
    host: "example.test:8443",
    origin: "https://teacher.example",
  });
  new Headers(extra).forEach((value, key) => {
    result.set(key, value);
  });
  return result;
}

function post(body: BodyInit | null = requestBody, extraHeaders: HeadersInit = {}): Request {
  return new Request(endpoint, {
    body,
    headers: headers(extraHeaders),
    method: "POST",
    ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
  });
}

async function responseFor(request: Request, overrides: PortOverrides = {}): Promise<Response> {
  return await createBunTransport(options(overrides)).fetch(request);
}

async function expectProblem(
  response: Response,
  status: number,
  code: string,
  bearerChallenge = false,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("www-authenticate")).toBe(
    bearerChallenge ? 'Bearer realm="marea"' : null,
  );
  expect(await response.text()).toBe(JSON.stringify({ error: { code } }));
}

describe("Bun transport HTTP boundary", () => {
  it("streams validated NDJSON through Marea-owned ports", async () => {
    const authenticate = vi.fn<AuthenticationPort["authenticate"]>(() =>
      Promise.resolve({
        authenticated: true,
        principal: { id: "a".repeat(128) },
      }),
    );
    const stream = vi.fn<StreamPort["stream"]>(async function* (request, context) {
      await Promise.resolve();
      expect(request).toEqual({ input: "Help", streamId: "stream_1" });
      expect(context.principal).toEqual({ id: "a".repeat(128) });
      expect(context.signal).toBeInstanceOf(AbortSignal);
      yield { data: "One", type: "data" };
      yield { type: "end" };
    });
    const transport = createBunTransport(
      options({ authentication: { authenticate }, streams: { stream } }),
    );
    expect(Object.isFrozen(transport)).toBe(true);

    const response = await transport.fetch(
      post(requestBody, {
        authorization: `bEaReR ${"x".repeat(8_185)}`,
        "content-type": " Application/JSON ; charset=utf-8",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe('{"data":"One","type":"data"}\n{"type":"end"}\n');
    expect(authenticate).toHaveBeenCalledWith("x".repeat(8_185), expect.any(AbortSignal));
    expect(stream).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    "Basic valid-token",
    "Bearer ",
    "Bearer two words",
    `Bearer ${"x".repeat(8_186)}`,
  ])("rejects a missing or malformed bearer credential %#", async (authorization) => {
    const requestHeaders = headers();
    if (authorization === undefined) {
      requestHeaders.delete("authorization");
    } else {
      requestHeaders.set("authorization", authorization);
    }
    const response = await responseFor(
      new Request(endpoint, { body: requestBody, headers: requestHeaders, method: "POST" }),
    );
    await expectProblem(response, 401, "authentication_failed", true);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="marea"');
  });

  it("maps rejected and failed authentication without exposing details", async () => {
    const rejected = await responseFor(post(), {
      authentication: {
        authenticate() {
          return Promise.resolve({ authenticated: false });
        },
      },
    });
    await expectProblem(rejected, 401, "authentication_failed", true);

    const failed = await responseFor(post(), {
      authentication: {
        authenticate() {
          return Promise.reject(new Error("private authentication detail"));
        },
      },
    });
    await expectProblem(failed, 503, "authentication_unavailable");
  });

  it("routes downstream failures through the application error boundary", async () => {
    const configured = options();
    Object.defineProperty(configured.ports, "streams", {
      get() {
        throw new Error("private downstream detail");
      },
    });
    const response = await createBunTransport(configured).fetch(post());
    await expectProblem(response, 500, "internal_error");
  });

  it.each(["", "a".repeat(129), "bad\u001fprincipal", "bad\u007fprincipal"])(
    "rejects an invalid authenticated principal %#",
    async (id) => {
      const response = await responseFor(post(), {
        authentication: {
          authenticate() {
            return Promise.resolve({ authenticated: true, principal: { id } });
          },
        },
      });
      await expectProblem(response, 503, "authentication_unavailable");
    },
  );

  it("accepts a printable principal containing a space", async () => {
    const response = await responseFor(post(), {
      authentication: {
        authenticate() {
          return Promise.resolve({ authenticated: true, principal: { id: "teacher one" } });
        },
      },
    });
    expect(response.status).toBe(200);
  });

  it("applies target policy before authentication and rejects URL credentials", async () => {
    const authenticate = vi.fn<AuthenticationPort["authenticate"]>();
    const wrongPort = await responseFor(post(requestBody, { host: "example.test:9999" }), {
      authentication: { authenticate },
    });
    await expectProblem(wrongPort, 403, "request_target_rejected");

    const queryRequest = new Request(`${endpoint}?access_token=secret`, {
      body: requestBody,
      headers: headers(),
      method: "POST",
    });
    await expectProblem(
      await responseFor(queryRequest, { authentication: { authenticate } }),
      403,
      "request_target_rejected",
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each([undefined, "text/plain", "application/json-patch+json"])(
    "requires the JSON media type %#",
    async (contentType) => {
      const requestHeaders = headers();
      if (contentType === undefined) {
        requestHeaders.delete("content-type");
      } else {
        requestHeaders.set("content-type", contentType);
      }
      const response = await responseFor(
        new Request(endpoint, { body: requestBody, headers: requestHeaders, method: "POST" }),
      );
      await expectProblem(response, 415, "invalid_content_type");
    },
  );

  it.each(["not-json", "{}", '{"input":"Help","streamId":"bad id"}'])(
    "rejects malformed request data %#",
    async (body) => {
      await expectProblem(await responseFor(post(body)), 400, "invalid_request");
    },
  );

  it("rejects malformed, mismatched, and oversized Content-Length", async () => {
    await expectProblem(
      await responseFor(post(requestBody, { "content-length": "-1" })),
      400,
      "invalid_request",
    );
    await expectProblem(
      await responseFor(post(requestBody, { "content-length": "1, 2" })),
      400,
      "invalid_request",
    );
    await expectProblem(
      await responseFor(post(requestBody, { "content-length": "1" })),
      400,
      "invalid_request",
    );
    await expectProblem(
      await responseFor(post(requestBody, { "content-length": String(MAX_REQUEST_BYTES + 1) })),
      413,
      "request_too_large",
    );
  });

  it("handles absent bodies consistently with Content-Length", async () => {
    await expectProblem(await responseFor(post(null)), 400, "invalid_request");
    await expectProblem(
      await responseFor(post(null, { "content-length": "1" })),
      400,
      "invalid_request",
    );
    await expectProblem(
      await responseFor(post(null, { "content-length": "0" })),
      400,
      "invalid_request",
    );
  });

  it("accepts a request of exactly the byte limit", async () => {
    const padding = " ".repeat(
      MAX_REQUEST_BYTES - new TextEncoder().encode(requestBody).byteLength,
    );
    const exactBody = requestBody + padding;
    const response = await responseFor(
      post(exactBody, { "content-length": String(MAX_REQUEST_BYTES) }),
    );
    expect(response.status).toBe(200);
  });

  it.each(["+", "x", "suffix", "decimal"])(
    "rejects a partially numeric Content-Length %#",
    async (variant) => {
      const length = String(new TextEncoder().encode(requestBody).byteLength);
      const contentLength =
        variant === "+"
          ? `+${length}`
          : variant === "x"
            ? `x${length}`
            : variant === "suffix"
              ? `${length}x`
              : `${length}.0`;
      await expectProblem(
        await responseFor(post(requestBody, { "content-length": contentLength })),
        400,
        "invalid_request",
      );
    },
  );

  it("decodes a multi-chunk body incrementally", async () => {
    const unicodeBody = JSON.stringify({ input: "Hé", streamId: "unicode-stream" });
    const bytes = new TextEncoder().encode(unicodeBody);
    const split = bytes.indexOf(195) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const response = await responseFor(post(body, { "content-length": String(bytes.byteLength) }));
    expect(response.status).toBe(200);
    expect(body.locked).toBe(false);
  });

  it("stops consuming an oversized chunked body even when cancellation fails", async () => {
    const cancel = vi.fn(() => {
      throw new Error("hostile cancel");
    });
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
      },
    });
    await expectProblem(await responseFor(post(body)), 413, "request_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not await a stream cancellation that never settles", async () => {
    const stalledCancel = Promise.withResolvers<undefined>().promise;
    const cancel = vi.fn(() => stalledCancel);
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
      },
    });
    const response = await Promise.race([
      responseFor(post(body)),
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("oversized response timed out"));
        }, 250);
      }),
    ]);
    await expectProblem(response, 413, "request_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([new Uint8Array([255]), new Uint8Array([195])])(
    "rejects invalid UTF-8 %#",
    async (invalidBody) => {
      await expectProblem(await responseFor(post(invalidBody)), 400, "invalid_request");
    },
  );

  it("rejects invalid UTF-8 that replacement decoding would accept", async () => {
    const prefix = new TextEncoder().encode('{"input":"');
    const suffix = new TextEncoder().encode('","streamId":"s"}');
    const invalidBody = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    invalidBody.set(prefix);
    invalidBody[prefix.byteLength] = 255;
    invalidBody.set(suffix, prefix.byteLength + 1);
    await expectProblem(await responseFor(post(invalidBody)), 400, "invalid_request");
  });

  it("maps an unexpected body read failure to a safe server error", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("private stream detail");
      },
    });
    const response = await responseFor(post(body));
    await expectProblem(response, 500, "internal_error");
  });

  it("returns a safe not-found response", async () => {
    const response = await createBunTransport(options()).fetch(
      new Request("http://example.test:8443/missing"),
    );
    await expectProblem(response, 404, "route_not_found");
  });

  it("does not claim the protocol-owned run-opening path", async () => {
    const authenticate = vi.fn<AuthenticationPort["authenticate"]>();
    const configured = options({ authentication: { authenticate } });
    const response = await createBunTransport(configured).fetch(
      new Request("http://example.test:8443/v1/runs", {
        body: requestBody,
        headers: headers(),
        method: "POST",
      }),
    );
    await expectProblem(response, 404, "route_not_found");
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("validates caller-supplied mounts when building the server", () => {
    const configured = options();
    expect(() =>
      createBunTransport({
        ...configured,
        mounts: { session: "/session", stream: "not-absolute" },
      }),
    ).toThrow("Transport mounts must be distinct static absolute paths.");
  });

  it("does not disguise an HTTP request as a successful WebSocket upgrade", async () => {
    const response = await createBunTransport(options()).fetch(
      new Request("http://example.test:8443/session", { headers: headers() }),
    );
    await expectProblem(response, 500, "internal_error");
  });

  it("upgrades an authenticated WebSocket with scoped connection data", async () => {
    const upgradedData: BunSocketData[] = [];
    const principals: string[] = [];
    const environment: BunUpgradeEnvironment = {
      upgrade(_request, upgradeOptions) {
        upgradedData.push(upgradeOptions.data);
        return true;
      },
    };
    const configured = options({
      sessions: {
        handle(_frame, context) {
          principals.push(context.principal.id);
          return Promise.resolve();
        },
      },
    });
    const response = await createBunTransport(configured).fetch(
      new Request("http://example.test:8443/session", {
        headers: headers({ "sec-websocket-protocol": "attacker-proposed" }),
      }),
      environment,
    );
    expect(response.status).toBe(200);
    expect(upgradedData).toHaveLength(1);
    expect(upgradedData[0]?.protocol).toBe("");
    expect(upgradedData[0]?.url.href).toBe("http://example.test:8443/session");
    expect(upgradedData[0]?.events.onMessage).toBeTypeOf("function");
    const peer = new WSContext({
      close() {
        throw new Error("The accepted frame must not close the peer.");
      },
      readyState: 1,
      send(data) {
        expect(typeof data).toBe("string");
      },
    });
    upgradedData[0]?.events.onMessage?.(
      createWSMessageEvent('{"type":"message","messageId":"m","input":"Help"}'),
      peer,
    );
    await vi.waitFor(() => {
      expect(principals).toEqual(["teacher-1"]);
    });
  });

  it("returns a safe error when Bun refuses an upgrade", async () => {
    const environment: BunUpgradeEnvironment = {
      upgrade() {
        return false;
      },
    };
    const response = await createBunTransport(options()).fetch(
      new Request("http://example.test:8443/session", { headers: headers() }),
      environment,
    );
    await expectProblem(response, 500, "internal_error");
  });
});
