import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURRENT_PROTOCOL_VERSION,
  MAX_TEACHING_CONFIGURATION_BYTES,
  MAX_SKILL_RESPONSE_BYTES,
  SkillAuthoringReadResponseSchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
  type SkillAuthoringDraft,
} from "@marea/protocol";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import {
  skillAuthoringDraftFixture,
  skillCatalogFixture,
  skillClassId,
  skillCopiedFixture,
  skillReadFixture,
  skillSavedFixture,
  skillValidatedFixture,
} from "./skill-authoring.fixture.js";
let createSkillAuthoringClient: typeof import("./skill-authoring-client.boundary.js").createSkillAuthoringClient;
beforeEach(async () => {
  vi.resetModules();
  ({ createSkillAuthoringClient } = await import("./skill-authoring-client.boundary.js"));
});

const signal = new AbortController().signal;

function validClasses(requestId = "request:one") {
  return TeachingClassesResponseSchema.parse({
    kind: "teaching-classes-response",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId,
    classes: [{ classId: skillClassId, displayName: "Physics" }],
    nextAfterClassId: null,
  });
}

function validCatalog(requestId = "request:one", classId = skillClassId) {
  return TeachingCatalogResponseSchema.parse({
    ...skillCatalogFixture,
    classId,
    requestId,
  });
}

function validRead(requestId = "request:one", classId = skillClassId) {
  return SkillAuthoringReadResponseSchema.parse({ ...skillReadFixture, classId, requestId });
}

function validValidated(requestId = "request:one", classId = skillClassId) {
  return { ...skillValidatedFixture, classId, requestId };
}

function validSaved(requestId = "request:one", classId = skillClassId) {
  return { ...skillSavedFixture, classId, requestId };
}

function validCopied(requestId = "request:one", classId = skillClassId) {
  return { ...skillCopiedFixture, classId, requestId };
}

function setup(...responses: readonly (object | Response)[]) {
  const fetchRequest = vi.fn<DashboardFetch>();
  for (const response of responses) {
    fetchRequest.mockResolvedValueOnce(
      response instanceof Response ? response : Response.json(response),
    );
  }
  return { fetchRequest, client: createSkillAuthoringClient(fetchRequest, () => "request:one") };
}

function bodyOf(fetchRequest: ReturnType<typeof vi.fn<DashboardFetch>>, index = -1): object {
  const body = fetchRequest.mock.calls.at(index)?.[1].body;
  if (typeof body !== "string") throw new Error("Expected a JSON body.");
  return JSON.parse(body) as object;
}

describe("skill authoring HTTP client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses exact same-origin uncached routes and frozen envelopes", async () => {
    const { client, fetchRequest } = setup(
      validClasses(),
      validCatalog(),
      validRead(),
      { ...validRead(), editable: false },
      validValidated(),
      validSaved(),
      validCopied(),
    );
    expect(await client.classes(null, signal)).toEqual(validClasses());
    expect(bodyOf(fetchRequest, 0)).toEqual({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: "request:one",
      kind: "teaching-classes-query",
      afterClassId: null,
    });
    expect(fetchRequest.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/teaching/classes");

    expect(await client.catalog(skillClassId, "marea/bundled", signal)).toEqual(validCatalog());
    expect(bodyOf(fetchRequest, 1)).toEqual({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: "request:one",
      kind: "teaching-catalog-query",
      classId: skillClassId,
      afterSkillId: "marea/bundled",
    });
    expect(fetchRequest.mock.calls[1]?.[0]).toBe("/api/v1/dashboard/teaching/catalog");

    expect(await client.readPersonal(skillClassId, "testing", signal)).toEqual(validRead());
    expect(bodyOf(fetchRequest, 2)).toEqual({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: "request:one",
      classId: skillClassId,
      kind: "skill-authoring-read",
      target: { scope: "personal", slug: "testing" },
    });
    expect(fetchRequest.mock.calls[2]?.[0]).toBe("/api/v1/dashboard/skill-authoring/read");

    expect(await client.readCatalog(skillClassId, "marea/bundled", signal)).toMatchObject({
      editable: false,
    });
    expect(bodyOf(fetchRequest, 3)).toMatchObject({
      target: { scope: "catalog", skillId: "marea/bundled" },
    });
    expect(fetchRequest.mock.calls[3]?.[0]).toBe("/api/v1/dashboard/skill-authoring/read");

    expect(await client.validate(skillClassId, skillAuthoringDraftFixture, signal)).toEqual(
      validValidated(),
    );
    expect(bodyOf(fetchRequest, 4)).toEqual({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: "request:one",
      classId: skillClassId,
      kind: "skill-authoring-validate",
      draft: skillAuthoringDraftFixture,
    });
    expect(fetchRequest.mock.calls[4]?.[0]).toBe("/api/v1/dashboard/skill-authoring/validate");

    expect(await client.save(skillClassId, skillAuthoringDraftFixture, null, signal)).toEqual(
      validSaved(),
    );
    expect(bodyOf(fetchRequest, 5)).toMatchObject({
      kind: "skill-authoring-save",
      expectedDigest: null,
    });
    expect(fetchRequest.mock.calls[5]?.[0]).toBe("/api/v1/dashboard/skill-authoring/save");
    expect(
      await client.copy(
        skillClassId,
        "marea/bundled",
        skillSavedFixture.skill.digest,
        "copied",
        signal,
      ),
    ).toEqual(validCopied());
    expect(bodyOf(fetchRequest, 6)).toEqual({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: "request:one",
      classId: skillClassId,
      kind: "skill-authoring-copy",
      sourceSkillId: "marea/bundled",
      sourceDigest: skillSavedFixture.skill.digest,
      slug: "copied",
    });
    expect(fetchRequest.mock.calls[6]?.[0]).toBe("/api/v1/dashboard/skill-authoring/copy");

    for (const call of fetchRequest.mock.calls) {
      expect(call[1]).toMatchObject({
        credentials: "same-origin",
        cache: "no-store",
        signal,
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      });
    }
  });

  it("maps HTTP status failures by operation", async () => {
    const cases: readonly [number, "forbidden" | "conflict" | "invalid" | "skill-unavailable"][] = [
      [401, "forbidden"],
      [403, "forbidden"],
      [409, "conflict"],
      [422, "skill-unavailable"],
      [400, "invalid"],
      [413, "invalid"],
    ];
    for (const [status, code] of cases) {
      const { client } = setup(new Response(null, { status }));
      await expect(client.readPersonal(skillClassId, "testing", signal)).rejects.toMatchObject({
        code,
      });
    }
    const serverError = setup(new Response(null, { status: 500 }));
    await expect(
      serverError.client.save(skillClassId, skillAuthoringDraftFixture, null, signal),
    ).rejects.toMatchObject({
      code: "uncertain",
    });
    const validationError = setup(new Response(null, { status: 500 }));
    await expect(
      validationError.client.validate(skillClassId, skillAuthoringDraftFixture, signal),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    const loadError = setup(new Response(null, { status: 500 }));
    await expect(loadError.client.classes(null, signal)).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring request failed.",
    });
  });

  it("rejects malformed, oversized, and crossed success responses", async () => {
    const malformedClasses = setup({});
    await expect(malformedClasses.client.classes(null, signal)).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring response violates its contract.",
    });
    const malformedCatalog = setup({});
    await expect(malformedCatalog.client.catalog(skillClassId, null, signal)).rejects.toMatchObject(
      {
        code: "load",
        message: "The skill authoring response violates its contract.",
      },
    );
    const malformed = setup(new Response("not JSON"));
    await expect(
      malformed.client.readPersonal(skillClassId, "testing", signal),
    ).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring response is not valid JSON.",
    });

    const wrongRequest = setup({ ...validRead(), requestId: "request:other" });
    await expect(
      wrongRequest.client.readPersonal(skillClassId, "testing", signal),
    ).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring response does not match its request.",
    });
    const wrongClass = setup(validRead("request:one", "class:other"));
    await expect(
      wrongClass.client.readPersonal(skillClassId, "testing", signal),
    ).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring response belongs to another class.",
    });
    const invalid = setup({});
    await expect(
      invalid.client.save(skillClassId, skillAuthoringDraftFixture, null, signal),
    ).rejects.toMatchObject({
      code: "uncertain",
      message: "The skill authoring response violates its contract.",
    });
    const malformedUtf8 = setup(new Response(new Uint8Array([0xff])));
    await expect(
      malformedUtf8.client.readPersonal(skillClassId, "testing", signal),
    ).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring response could not be read.",
    });

    const oversized = new Uint8Array(MAX_SKILL_RESPONSE_BYTES + 1);
    const tooLarge = setup(new Response(oversized));
    await expect(
      tooLarge.client.save(skillClassId, skillAuthoringDraftFixture, null, signal),
    ).rejects.toMatchObject({
      code: "uncertain",
      message: "The skill authoring response is too large.",
    });

    const oversizedClasses = setup(
      new Response(new Uint8Array(MAX_TEACHING_CONFIGURATION_BYTES + 1)),
    );
    await expect(oversizedClasses.client.classes(null, signal)).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring response is too large.",
    });

    const expectWrongClass = async (request: Promise<object>, code: string) => {
      await expect(request).rejects.toMatchObject({
        code,
        message: "The skill authoring response belongs to another class.",
      });
    };
    await expectWrongClass(
      setup(validCatalog("request:one", "class:other")).client.catalog(skillClassId, null, signal),
      "load",
    );
    await expectWrongClass(
      setup(validRead("request:one", "class:other")).client.readCatalog(
        skillClassId,
        "marea/bundled",
        signal,
      ),
      "load",
    );
    await expectWrongClass(
      setup(validValidated("request:one", "class:other")).client.validate(
        skillClassId,
        skillAuthoringDraftFixture,
        signal,
      ),
      "invalid",
    );
    await expectWrongClass(
      setup(validSaved("request:one", "class:other")).client.save(
        skillClassId,
        skillAuthoringDraftFixture,
        null,
        signal,
      ),
      "uncertain",
    );
    await expectWrongClass(
      setup(validCopied("request:one", "class:other")).client.copy(
        skillClassId,
        "marea/bundled",
        skillSavedFixture.skill.digest,
        "copied",
        signal,
      ),
      "uncertain",
    );
  });

  it("wraps transport failures but preserves aborts", async () => {
    const network = vi.fn<DashboardFetch>(() => {
      throw new TypeError("offline");
    });
    const client = createSkillAuthoringClient(network, () => "request:one");
    await expect(client.classes(null, signal)).rejects.toMatchObject({
      code: "load",
      message: "The skill authoring request could not be sent.",
    });
    await expect(
      client.validate(skillClassId, skillAuthoringDraftFixture, signal),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      client.copy(skillClassId, "marea/bundled", skillSavedFixture.skill.digest, "copied", signal),
    ).rejects.toMatchObject({
      code: "uncertain",
    });

    const abort = new AbortController();
    const aborted = new Error("aborted");
    const abortedFetch = vi.fn<DashboardFetch>(() => {
      throw aborted;
    });
    const abortedClient = createSkillAuthoringClient(abortedFetch, () => "request:one");
    abort.abort(aborted);
    await expect(abortedClient.classes(null, abort.signal)).rejects.toBe(aborted);

    const abortDuringFetch = new AbortController();
    const duringFetchError = new Error("aborted while sending");
    const duringFetch = vi.fn<DashboardFetch>(() => {
      abortDuringFetch.abort(duringFetchError);
      throw duringFetchError;
    });
    await expect(
      createSkillAuthoringClient(duringFetch, () => "request:one").classes(
        null,
        abortDuringFetch.signal,
      ),
    ).rejects.toBe(duringFetchError);

    const abortDuringRead = new AbortController();
    const readError = new Error("aborted while reading");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          abortDuringRead.abort(readError);
          controller.error(readError);
        },
      }),
    );
    const readFetch = vi.fn<DashboardFetch>(() => Promise.resolve(response));
    await expect(
      createSkillAuthoringClient(readFetch, () => "request:one").classes(
        null,
        abortDuringRead.signal,
      ),
    ).rejects.toBe(readError);

    const preAborted = new AbortController();
    preAborted.abort(new Error("already cancelled"));
    const preAbortFetch = vi.fn<DashboardFetch>();
    await expect(
      createSkillAuthoringClient(preAbortFetch, () => "request:one").classes(
        null,
        preAborted.signal,
      ),
    ).rejects.toBe(preAborted.signal.reason);
    expect(preAbortFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid request inputs before fetch and creates browser IDs", async () => {
    const { fetchRequest } = setup(validClasses());
    const invalid = createSkillAuthoringClient(fetchRequest, () => "bad request id");
    expect(() => invalid.classes(null, signal)).toThrow();
    expect(fetchRequest).not.toHaveBeenCalled();

    const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000000");
    vi.stubGlobal("crypto", { randomUUID });
    const browserFetch = vi.fn<DashboardFetch>(() =>
      Promise.resolve(Response.json(validClasses("request:00000000-0000-4000-8000-000000000000"))),
    );
    const browserClient = createSkillAuthoringClient(browserFetch);
    await browserClient.classes(null, signal);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("does not hide the request-boundary type from the draft API", () => {
    const draft: SkillAuthoringDraft = skillAuthoringDraftFixture;
    expect(draft.files[0]?.content).toBe("Teach one idea.");
  });
});
