import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryExporterError } from "@marea/plugin-api";
import { createLangfuseExporter } from "./exporter.js";
import plugin from "./index.js";
import { collector, envelope, settings, signal } from "./exporter.fixture.js";
import { encodeEnvelope } from "./wire.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
const connection = {
  endpoint: "http://127.0.0.1:1",
  publicKey: "synthetic-public",
  secretKey: "synthetic-secret",
};
const unavailable = new TelemetryExporterError("unavailable");

describe("Langfuse factory", () => {
  it("provides an executable catalog entry and constructs without I/O or timers", () => {
    const transport = vi.spyOn(globalThis, "fetch");
    const timer = vi.spyOn(globalThis, "setTimeout");
    expect(plugin.implementation?.destination).toBe("langfuse");
    expect(plugin.implementation?.create).toBe(createLangfuseExporter);
    expect(plugin.manifest.acceptedDataClassifications).toEqual(["operational"]);
    expect(createLangfuseExporter(settings, connection).id).toBe("langfuse");
    expect(transport).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "ftp://localhost",
    "https://user:pass@localhost",
    "https://localhost?secret=x",
    "https://localhost#secret",
    " http://localhost",
    "http://local host",
    "http:\\localhost",
    "garbage",
  ])("rejects private endpoint %s", (endpoint) => {
    expect(() => createLangfuseExporter(settings, { ...connection, endpoint })).toThrow(
      new TelemetryExporterError("invalid-configuration"),
    );
  });
  it.each(["", "bad\r\nkey", "bad:key", "é", "a".repeat(1025)])("rejects invalid keys", (key) => {
    for (const field of ["publicKey", "secretKey"])
      expect(() => createLangfuseExporter(settings, { ...connection, [field]: key })).toThrow(
        new TelemetryExporterError("invalid-configuration"),
      );
  });
  it("validates configuration", () => {
    expect(() =>
      createLangfuseExporter({ ...settings, operationTimeoutMs: 0 }, connection),
    ).toThrow(new TelemetryExporterError("invalid-configuration"));
    // @ts-expect-error Deliberately wrong destination at a runtime boundary.
    expect(() => createLangfuseExporter({ ...settings, destination: "otlp" }, connection)).toThrow(
      new TelemetryExporterError("invalid-configuration"),
    );
  });
});

describe("real HTTP collector", () => {
  it("snapshots settings and connection and sends exact point-event OTLP with intact metric metadata", async () => {
    const requests: {
      url: string | undefined;
      authorization: string | undefined;
      version: string | string[] | undefined;
      contentType: string | undefined;
      accept: string | undefined;
      body: string;
    }[] = [];
    const local = await collector((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          version: request.headers["x-langfuse-ingestion-version"],
          contentType: request.headers["content-type"],
          accept: request.headers.accept,
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    cleanup.push(local.close);
    const config = { ...settings, maxRequestBytes: 262144, maxResponseBytes: 2 };
    const port = createLangfuseExporter(config, local.connection);
    local.connection.endpoint = "http://127.0.0.1:1";
    local.connection.secretKey = "changed";
    config.maxRequestBytes = 1;
    config.maxResponseBytes = 1;
    await port.export(envelope, signal());
    await port.export(envelope, signal());
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("/base/api/public/otel/v1/traces");
    expect(requests[0]?.authorization).toBe(`Basic ${btoa("synthetic-public:synthetic-secret")}`);
    expect(requests[0]?.version).toBe("4");
    expect(requests[0]?.contentType).toBe("application/json");
    expect(requests[0]?.accept).toBe("application/json");
    const expected = JSON.parse(new TextDecoder().decode(encodeEnvelope(envelope))) as object;
    const wire = JSON.parse(requests[0]?.body ?? "") as object;
    expect(wire).toMatchObject(expectedWithoutIds(expected));
    expect(requests[0]?.body).not.toBe(requests[1]?.body);
    expect(requests[0]?.body).not.toMatch(/synthetic|userId|sessionId|prompt|parentSpanId/);
    await port.shutdown(signal());
  });
  it.each([301, 302, 307, 308, 400, 401, 403, 413, 429, 500, 503, 207, 204])(
    "rejects HTTP %i without redirects or retries",
    async (status) => {
      let calls = 0;
      const local = await collector((_request, response) => {
        calls++;
        response.writeHead(status, {
          location: "/credential-leak",
          "content-type": "application/json",
        });
        response.end("{}");
      });
      cleanup.push(local.close);
      const port = createLangfuseExporter(settings, local.connection);
      await expect(port.export(envelope, signal())).rejects.toEqual(unavailable);
      expect(calls).toBe(1);
      await port.shutdown(signal());
    },
  );
  it.each([
    ["{}", true],
    ['{"partialSuccess":{}}', true],
    ['{"partialSuccess":{"rejectedSpans":"0","errorMessage":"private warning"}}', true],
    ['{"partialSuccess":{"rejectedSpans":0}}', true],
    ['{"partialSuccess":{"rejectedSpans":"1","errorMessage":"private secret"}}', false],
    ['{"partialSuccess":{"rejectedSpans":-1}}', false],
    ['{"partialSuccess":null}', false],
    ['{"partialSuccess":{"errorMessage":1}}', false],
    ["[]", false],
    ["null", false],
    ["broken", false],
    ["", false],
  ])("handles bounded acknowledgement %s", async (body, success) => {
    const local = await collector((_request, response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
    });
    cleanup.push(local.close);
    const port = createLangfuseExporter(settings, local.connection);
    if (success) await expect(port.export(envelope, signal())).resolves.toBeUndefined();
    else await expect(port.export(envelope, signal())).rejects.toEqual(unavailable);
    await port.shutdown(signal());
  });
  it("bounds chunked response bytes and cancels the stream", async () => {
    const local = await collector((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write(" ".repeat(101));
    });
    cleanup.push(local.close);
    const port = createLangfuseExporter({ ...settings, maxResponseBytes: 100 }, local.connection);
    await expect(port.export(envelope, signal())).rejects.toEqual(
      new TelemetryExporterError("payload-too-large"),
    );
    await port.shutdown(signal());
  });
  it.each(["headers", "body"])(
    "bounds total deadline while awaiting %s without caller abort",
    async (phase) => {
      const local = await collector((_request, response) => {
        if (phase === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("{");
        }
      });
      cleanup.push(local.close);
      const port = createLangfuseExporter(
        { ...settings, operationTimeoutMs: 30 },
        local.connection,
      );
      await expect(port.export(envelope, signal())).rejects.toEqual(
        new TelemetryExporterError("cancelled"),
      );
      await port.shutdown(signal());
    },
  );
  it.each(["caller", "shutdown", "cancelled-shutdown"])(
    "interrupts in-flight body with %s",
    async (mode) => {
      let arrived: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const local = await collector((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
        arrived();
      });
      cleanup.push(local.close);
      const port = createLangfuseExporter(settings, local.connection);
      const controller = new AbortController();
      const pending = expect(port.export(envelope, controller.signal)).rejects.toEqual(
        new TelemetryExporterError("cancelled"),
      );
      await ready;
      if (mode === "caller") controller.abort();
      else {
        const closeSignal = new AbortController();
        if (mode === "cancelled-shutdown") closeSignal.abort();
        const closing = port.shutdown(closeSignal.signal);
        expect(port.shutdown(signal())).toBe(closing);
        if (mode === "cancelled-shutdown")
          await expect(closing).rejects.toEqual(new TelemetryExporterError("cancelled"));
        else await closing;
        await expect(port.export(envelope, signal())).rejects.toEqual(
          new TelemetryExporterError("closed"),
        );
      }
      await pending;
    },
  );
  it("rejects encoding errors and pre-abort before I/O and bounds encoded UTF-8 bytes", async () => {
    const transport = vi.spyOn(globalThis, "fetch");
    const port = createLangfuseExporter(settings, connection);
    await expect(port.export({ ...envelope, occurredAt: "invalid" }, signal())).rejects.toEqual(
      unavailable,
    );
    const controller = new AbortController();
    controller.abort("private");
    await expect(port.export(envelope, controller.signal)).rejects.toEqual(
      new TelemetryExporterError("cancelled"),
    );
    const unicode = { ...envelope, eventName: "é".repeat(100) };
    const bytes = encodeEnvelope(unicode).byteLength;
    const small = createLangfuseExporter({ ...settings, maxRequestBytes: bytes - 1 }, connection);
    await expect(small.export(unicode, signal())).rejects.toEqual(
      new TelemetryExporterError("payload-too-large"),
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it("suppresses network errors and rejects invalid UTF-8 and response types", async () => {
    await expect(
      createLangfuseExporter(settings, connection).export(envelope, signal()),
    ).rejects.toEqual(unavailable);
    for (const contentType of ["application/json", "text/plain"]) {
      const local = await collector((_request, response) => {
        response.writeHead(200, { "content-type": contentType });
        response.end(contentType === "text/plain" ? "{}" : new Uint8Array([255]));
      });
      cleanup.push(local.close);
      await expect(
        createLangfuseExporter(settings, local.connection).export(envelope, signal()),
      ).rejects.toEqual(unavailable);
    }
  });
});

function expectedWithoutIds(value: object): object {
  // Compare the entire wire layout; only cryptographically random transport IDs vary.
  return JSON.parse(
    JSON.stringify(value)
      .replace(/"traceId":"[a-f0-9]+",/u, "")
      .replace(/"spanId":"[a-f0-9]+",/u, ""),
  ) as object;
}

const secureConnection = { endpoint: "https://localhost/", publicKey: "p", secretKey: "s" };
it("accepts the exact encoded request bound and rejects one byte less", async () => {
  let calls = 0;
  const local = await collector((_request, response) => {
    calls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  cleanup.push(local.close);
  const sample = { ...envelope, eventName: "é測定" };
  const size = encodeEnvelope(sample).byteLength;
  await createLangfuseExporter({ ...settings, maxRequestBytes: size }, local.connection).export(
    sample,
    signal(),
  );
  await expect(
    createLangfuseExporter({ ...settings, maxRequestBytes: size - 1 }, local.connection).export(
      sample,
      signal(),
    ),
  ).rejects.toEqual(new TelemetryExporterError("payload-too-large"));
  expect(calls).toBe(1);
});
it("releases timer, listener and active transport on success and terminal shutdown", async () => {
  vi.useFakeTimers();
  let transportSignal: AbortSignal | null | undefined;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    transportSignal = init?.signal;
    return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
  });
  const port = createLangfuseExporter(settings, secureConnection);
  const caller = signal();
  const remove = vi.spyOn(caller, "removeEventListener");
  await port.export(envelope, caller);
  expect(transport).toHaveBeenCalledWith(
    "https://localhost/api/public/otel/v1/traces",
    expect.objectContaining({ method: "POST", redirect: "error" }),
  );
  expect(transportSignal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  const closed = port.shutdown(caller);
  expect(port.shutdown(AbortSignal.abort())).toBe(closed);
  await closed;
  await expect(port.export(envelope, AbortSignal.abort())).rejects.toEqual(
    new TelemetryExporterError("closed"),
  );
  expect(transport).toHaveBeenCalledTimes(1);
});
it("rejects malformed runtime connection values with safe errors", () => {
  for (const endpoint of [null, 123]) {
    // @ts-expect-error Untyped private boundary misuse.
    expect(() => createLangfuseExporter(settings, { ...secureConnection, endpoint })).toThrow(
      new TelemetryExporterError("invalid-configuration"),
    );
  }
  // @ts-expect-error Untyped private boundary misuse.
  expect(() => createLangfuseExporter(settings, null)).toThrow(
    new TelemetryExporterError("invalid-configuration"),
  );
  // @ts-expect-error Untyped private boundary misuse.
  expect(() => createLangfuseExporter(settings, { ...secureConnection, publicKey: null })).toThrow(
    new TelemetryExporterError("invalid-configuration"),
  );
  expect(() =>
    createLangfuseExporter(settings, { ...secureConnection, endpoint: "https://:pass@localhost" }),
  ).toThrow(new TelemetryExporterError("invalid-configuration"));
});
it.each([undefined, "application/json", "text/plain"])(
  "rejects missing body or media type (%s)",
  async (contentType) => {
    const response = contentType
      ? new Response(null, { headers: { "content-type": contentType } })
      : new Response("{}");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(
      createLangfuseExporter(settings, secureConnection).export(envelope, signal()),
    ).rejects.toEqual(new TelemetryExporterError("unavailable"));
  },
);
it("decodes split multibyte UTF-8, counts all chunks, and releases the reader", async () => {
  const bytes = new TextEncoder().encode(
    '{"partialSuccess":{"rejectedSpans":0,"errorMessage":"é"}}',
  );
  const split = bytes.indexOf(195) + 1;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(stream, { headers: { "content-type": "application/json" } }),
  );
  await createLangfuseExporter(
    { ...settings, maxResponseBytes: bytes.length },
    secureConnection,
  ).export(envelope, signal());
  expect(stream.locked).toBe(false);
});

it("preserves all deployment base path segments", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
  await createLangfuseExporter(settings, {
    ...secureConnection,
    endpoint: "https://localhost/nested/base/",
  }).export(envelope, signal());
  expect(fetch.mock.calls[0]?.[0]).toBe("https://localhost/nested/base/api/public/otel/v1/traces");
});
it("does not accept a URL object in place of a private endpoint string", () => {
  expect(() =>
    createLangfuseExporter(settings, {
      ...secureConnection,
      // @ts-expect-error Untyped connection boundary misuse.
      endpoint: new URL("https://localhost"),
    }),
  ).toThrow(new TelemetryExporterError("invalid-configuration"));
});
it("rejects malformed UTF-8 inside otherwise valid JSON strings", async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{"ignored":"'),
    255,
    ...new TextEncoder().encode('"}'),
  ]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(bytes, { headers: { "content-type": "application/json" } }),
  );
  await expect(
    createLangfuseExporter(settings, secureConnection).export(envelope, signal()),
  ).rejects.toEqual(unavailable);
});
