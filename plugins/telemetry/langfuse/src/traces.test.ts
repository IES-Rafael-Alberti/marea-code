import { expect, it } from "vitest";
import * as z from "zod";
import { sessionTraceFixture as trace } from "@marea/plugin-api/testing";
import { collector, signal } from "./exporter.fixture.js";
import { traces } from "./traces.js";
const Wire = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              traceId: z.string(),
              spanId: z.string(),
              parentSpanId: z.string().optional(),
              attributes: z.array(
                z.object({
                  key: z.string(),
                  value: z.object({
                    stringValue: z.string().optional(),
                    intValue: z.string().optional(),
                  }),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});
it("sends full linked observations to a custom Langfuse base URL with v4 authentication and usage", async () => {
  const captured = Promise.withResolvers<{
    path: string | undefined;
    auth: string | undefined;
    version: string | string[] | undefined;
    body: string;
  }>();
  const c = await collector((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      captured.resolve({
        path: request.url,
        auth: request.headers.authorization,
        version: request.headers["x-langfuse-ingestion-version"],
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  try {
    await traces.create(c.connection).export(trace, signal());
    const result = await captured.promise;
    expect(result.path).toBe("/base/api/public/otel/v1/traces");
    expect(result.auth).toBe(`Basic ${btoa("synthetic-public:synthetic-secret")}`);
    expect(result.version).toBe("4");
    const spans = Wire.parse(JSON.parse(result.body)).resourceSpans.flatMap((r) =>
      r.scopeSpans.flatMap((s) => s.spans),
    );
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.traceId).toBe(trace.id);
      expect(span.attributes).toEqual(
        expect.arrayContaining([
          { key: "langfuse.session.id", value: { stringValue: trace.sessionId } },
          { key: "langfuse.user.id", value: { stringValue: trace.userId } },
          { key: "langfuse.release", value: { stringValue: trace.release } },
        ]),
      );
    }
    expect(spans[1]?.attributes).toEqual(
      expect.arrayContaining([
        { key: "langfuse.observation.model.name", value: { stringValue: "model-name" } },
        {
          key: "langfuse.observation.usage_details",
          value: { stringValue: '{"input":12,"output":8}' },
        },
        { key: "langfuse.observation.type", value: { stringValue: "generation" } },
      ]),
    );
    expect(JSON.parse(result.body)).toMatchSnapshot("Langfuse content and observation attributes");
    expect(result.body).not.toContain("synthetic-secret");
  } finally {
    await c.close();
  }
});
it("rejects missing trace destination credentials before network activity", () => {
  for (const values of [
    {},
    { endpoint: "https://example.test" },
    { endpoint: "https://example.test", publicKey: "synthetic" },
  ])
    expect(() => traces.create(values)).toThrow(
      expect.objectContaining({ code: "invalid-configuration" }),
    );
});

it("keeps all localized credential fields and the cloud default in its plugin descriptor", () => {
  expect(traces.settings).toMatchSnapshot();
});
