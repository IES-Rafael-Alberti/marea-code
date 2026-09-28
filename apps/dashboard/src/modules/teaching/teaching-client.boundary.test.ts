import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeachingSettings } from "@marea/protocol";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import type { TeachingProblem } from "./teaching-contracts.js";

import {
  CLASS_A,
  CLASS_B,
  VERSION_A,
  VERSION_B,
  catalogPage,
  classesPage,
  classSummary,
  configuration,
  readResponse,
  savedResponse,
  settings,
  skillEntry,
} from "./teaching-controller.fixture.js";
import { captureFetch, expectProblem, type CapturedRequest } from "./teaching-client.fixture.js";
import { createTeachingClient, localTeachingClient } from "./teaching-client.boundary.js";

const signal = new AbortController().signal;

function ok(value: object) {
  return captureFetch(() => Response.json(value));
}

async function requestText(requests: readonly CapturedRequest[]): Promise<string> {
  return (await requests[0]?.request.text()) ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("accepts a full valid catalog page larger than a query request limit", async () => {
  const page = catalogPage(
    CLASS_A,
    Array.from({ length: 100 }, (_, index) => ({
      ...skillEntry(`marea/skill-${String(index)}`),
      description: "d".repeat(1_000),
    })),
  );
  expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeGreaterThan(64 * 1_024);
  const client = createTeachingClient(ok(page).fetchRequest, () => "request:one");
  await expect(client.catalog(CLASS_A, null, signal)).resolves.toEqual(page);
});

describe("teaching dashboard HTTP client", () => {
  it("posts same-origin, uncached, correlated teaching requests", async () => {
    const classes = ok(classesPage([classSummary()], CLASS_A));
    const classesClient = createTeachingClient(classes.fetchRequest, () => "request:one");
    expect(await classesClient.classes(null, signal)).toEqual(
      classesPage([classSummary()], CLASS_A),
    );
    const classRequest = classes.requests[0]?.request;
    expect(classes.requests[0]?.request.url).toBe(
      "http://dashboard.local/api/v1/dashboard/teaching/classes",
    );
    expect(classRequest?.method).toBe("POST");
    expect(classes.requests[0]?.init.credentials).toBe("same-origin");
    expect(classes.requests[0]?.init.cache).toBe("no-store");
    expect(classRequest?.headers.get("Accept")).toBe("application/json");
    expect(classRequest?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(await requestText(classes.requests))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "teaching-classes-query",
      afterClassId: null,
    });

    const read = ok(readResponse(CLASS_A, configuration(VERSION_A)));
    const readClient = createTeachingClient(read.fetchRequest, () => "request:one");
    expect(await readClient.read(CLASS_A, signal)).toEqual(
      readResponse(CLASS_A, configuration(VERSION_A)),
    );
    expect(read.requests[0]?.request.url).toBe(
      "http://dashboard.local/api/v1/dashboard/teaching/read",
    );
    expect(JSON.parse(await requestText(read.requests))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "teaching-configuration-query",
      classId: CLASS_A,
    });

    const catalog = ok(catalogPage(CLASS_A, [skillEntry()], "marea/testing"));
    const catalogClient = createTeachingClient(catalog.fetchRequest, () => "request:one");
    expect(await catalogClient.catalog(CLASS_A, "marea/testing", signal)).toEqual(
      catalogPage(CLASS_A, [skillEntry()], "marea/testing"),
    );
    expect(catalog.requests[0]?.request.url).toBe(
      "http://dashboard.local/api/v1/dashboard/teaching/catalog",
    );
    expect(JSON.parse(await requestText(catalog.requests))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "teaching-catalog-query",
      classId: CLASS_A,
      afterSkillId: "marea/testing",
    });

    const saved = ok(savedResponse(CLASS_A, configuration(VERSION_B)));
    const saveClient = createTeachingClient(saved.fetchRequest, () => "request:one");
    expect(await saveClient.save(CLASS_A, null, settings(), signal)).toEqual(
      savedResponse(CLASS_A, configuration(VERSION_B)),
    );
    expect(saved.requests[0]?.request.url).toBe(
      "http://dashboard.local/api/v1/dashboard/teaching/save",
    );
    expect(JSON.parse(await requestText(saved.requests))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "teaching-configuration-save",
      classId: CLASS_A,
      expectedVersion: null,
      settings: settings(),
    });
  });

  it("maps sanitized HTTP failures by operation", async () => {
    const statusCases: readonly (readonly [number, TeachingProblem])[] = [
      [401, "forbidden"],
      [403, "forbidden"],
      [409, "conflict"],
      [422, "skill-unavailable"],
      [503, "unconfigured"],
      [400, "invalid"],
      [413, "invalid"],
    ];
    for (const [status, code] of statusCases) {
      const { fetchRequest } = captureFetch(() => new Response(null, { status }));
      const client = createTeachingClient(fetchRequest, () => "request:one");
      await expectProblem(client.read(CLASS_A, signal), code, "The teaching request failed.");
    }
    const unexpected = captureFetch(() => new Response(null, { status: 500 }));
    const unexpectedClient = createTeachingClient(unexpected.fetchRequest, () => "request:one");
    await expectProblem(
      unexpectedClient.classes(null, signal),
      "load",
      "The teaching request failed.",
    );
    await expectProblem(
      unexpectedClient.catalog(CLASS_A, null, signal),
      "load",
      "The teaching request failed.",
    );
    await expectProblem(
      unexpectedClient.save(CLASS_A, null, settings(), signal),
      "uncertain",
      "The teaching request failed.",
    );
  });

  it("treats malformed, oversized, and mismatched successes as read or uncertain failures", async () => {
    const malformed = ok({});
    const malformedClient = createTeachingClient(malformed.fetchRequest, () => "request:one");
    await expectProblem(
      malformedClient.read(CLASS_A, signal),
      "load",
      "The teaching response violates its contract.",
    );
    await expectProblem(
      malformedClient.save(CLASS_A, null, settings(), signal),
      "uncertain",
      "The teaching response violates its contract.",
    );

    const wrongRequest = ok(readResponse(CLASS_A, configuration(VERSION_A)));
    const wrongRequestClient = createTeachingClient(wrongRequest.fetchRequest, () => "request:two");
    await expectProblem(
      wrongRequestClient.read(CLASS_A, signal),
      "load",
      "The teaching response does not match its request.",
    );

    const wrongClass = ok(readResponse(CLASS_A, configuration(VERSION_A)));
    const wrongClassClient = createTeachingClient(wrongClass.fetchRequest, () => "request:one");
    await expectProblem(
      wrongClassClient.read(CLASS_B, signal),
      "load",
      "The teaching response belongs to another class.",
    );

    const oversized = captureFetch(() => new Response("x".repeat(4 * 1_024 * 1_024 + 1)));
    const oversizedClient = createTeachingClient(oversized.fetchRequest, () => "request:one");
    await expectProblem(
      oversizedClient.classes(null, signal),
      "load",
      "The teaching response is too large.",
    );

    const invalidJson = captureFetch(() => new Response("not json"));
    const invalidJsonClient = createTeachingClient(invalidJson.fetchRequest, () => "request:one");
    await expectProblem(
      invalidJsonClient.classes(null, signal),
      "load",
      "The teaching response is not valid JSON.",
    );
    const boundaryJson = captureFetch(() => new Response("x".repeat(4 * 1_024 * 1_024)));
    const boundaryJsonClient = createTeachingClient(boundaryJson.fetchRequest, () => "request:one");
    await expectProblem(
      boundaryJsonClient.classes(null, signal),
      "load",
      "The teaching response is not valid JSON.",
    );
  });

  it("wraps network failures without masking aborts", async () => {
    const abortError = new Error("The teaching request was aborted.");
    const aborted = new AbortController();
    aborted.abort(abortError);
    const network = captureFetch(() => {
      throw new TypeError("network down");
    });
    const networkClient = createTeachingClient(network.fetchRequest, () => "request:one");
    await expectProblem(
      networkClient.classes(null, signal),
      "load",
      "The teaching request could not be sent.",
    );
    await expectProblem(
      networkClient.save(CLASS_A, null, settings(), signal),
      "uncertain",
      "The teaching request could not be sent.",
    );

    const abortedFetch = vi.fn<DashboardFetch>(() => {
      throw abortError;
    });
    const abortedClient = createTeachingClient(abortedFetch, () => "request:one");
    await expect(abortedClient.classes(null, aborted.signal)).rejects.toBe(abortError);

    const abortedBody = new Response();
    const abortedText = captureFetch(() => abortedBody);
    const abortedTextClient = createTeachingClient(abortedText.fetchRequest, () => "request:one");
    await expect(abortedTextClient.classes(null, aborted.signal)).rejects.toBe(abortError);

    const brokenBody = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("stream"));
        },
      }),
    );
    const brokenText = captureFetch(() => brokenBody);
    const brokenTextClient = createTeachingClient(brokenText.fetchRequest, () => "request:one");
    await expectProblem(
      brokenTextClient.classes(null, signal),
      "load",
      "The teaching response could not be read.",
    );
  });

  it("rejects invalid caller inputs before sending a request", () => {
    const { fetchRequest } = ok(savedResponse(CLASS_A, configuration(VERSION_A)));
    const invalidId = createTeachingClient(fetchRequest, () => "invalid request id");
    expect(() => invalidId.classes(null, signal)).toThrow();
    const invalidSettings: Partial<TeachingSettings> = { agentMode: "tutoring" };
    const invalidSave = createTeachingClient(fetchRequest, () => "request:one");
    expect(() =>
      invalidSave.save(CLASS_A, null, invalidSettings as TeachingSettings, signal),
    ).toThrow();
    expect(() =>
      invalidSave.save(
        CLASS_A,
        null,
        settings({ automaticEvaluation: true, selection: { didactic: [], evaluation: [] } }),
        signal,
      ),
    ).toThrow();
  });

  it("creates browser request identifiers and uses the browser fetch by default", async () => {
    const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000000");
    vi.stubGlobal("crypto", { randomUUID });
    const browserFetch = vi.fn<DashboardFetch>(() =>
      Promise.resolve(
        Response.json({
          ...classesPage([classSummary()], null),
          requestId: "request:00000000-0000-4000-8000-000000000000",
        }),
      ),
    );
    vi.stubGlobal("fetch", browserFetch);
    await expect(localTeachingClient.classes(null, signal)).resolves.toMatchObject({
      requestId: "request:00000000-0000-4000-8000-000000000000",
    });
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(browserFetch.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/teaching/classes");
  });
});
