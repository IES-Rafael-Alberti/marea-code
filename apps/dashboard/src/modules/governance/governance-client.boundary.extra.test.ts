import { describe, expect, it, vi } from "vitest";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createGovernanceClient } from "./governance-client.boundary.js";
import {
  readGovernanceResponse,
  serializeGovernanceRequest,
} from "./governance-response.boundary.js";
import {
  classPageFetch,
  mockFetch,
  readRequest,
  classRow,
  accountRow,
  centerId,
  classId,
  exchange,
  id,
  previewId,
  responseFor,
  signal,
  userId,
  version,
} from "./governance-client.boundary.fixture.js";

describe("governance browser transport extended cases", () => {
  it("handles request-id, schema, network, and query status failures safely", async () => {
    const malformed = mockFetch(() => new Response("{}"));
    await expect(
      createGovernanceClient(malformed, () => "request:one").access(signal),
    ).rejects.toMatchObject({ code: "load", message: "The governance response is invalid." });

    const wrongId = mockFetch(
      () =>
        new Response(
          JSON.stringify({ ...responseFor("governance-access-query"), requestId: "request:other" }),
        ),
    );
    await expect(
      createGovernanceClient(wrongId, () => "request:one").access(signal),
    ).rejects.toMatchObject({ code: "load", message: "The governance response is invalid." });

    const network = mockFetch(() => {
      throw new Error("offline");
    });
    await expect(
      createGovernanceClient(network, () => "request:one").access(signal),
    ).rejects.toMatchObject({ code: "load", message: "The governance request could not be sent." });
    await expect(
      createGovernanceClient(network, () => "request:one").renameClass(
        { centerId, classId, displayName: "Renamed", expectedVersion: version },
        signal,
      ),
    ).rejects.toMatchObject({ code: "uncertain" });

    const queryAbort = new AbortController();
    const abortDuringFetch = mockFetch(() => {
      queryAbort.abort(new Error("query aborted"));
      throw new Error("fetch aborted");
    });
    await expect(
      createGovernanceClient(abortDuringFetch, () => "request:one").access(queryAbort.signal),
    ).rejects.toMatchObject({ code: "uncertain" });

    const responseAbort = new AbortController();
    const abortAfterFetch = mockFetch(() => {
      responseAbort.abort(new Error("response aborted"));
      return new Response(JSON.stringify(responseFor("governance-access-query")));
    });
    await expect(
      createGovernanceClient(abortAfterFetch, () => "request:one").access(responseAbort.signal),
    ).rejects.toMatchObject({ code: "uncertain" });

    const serverError = mockFetch(() => new Response("private", { status: 500 }));
    await expect(
      createGovernanceClient(serverError, () => "request:one").access(signal),
    ).rejects.toMatchObject({ code: "load", message: "The governance request was rejected." });

    await expect(
      createGovernanceClient(vi.fn<DashboardFetch>(), () => "bad id").access(signal),
    ).rejects.toMatchObject({ code: "invalid", message: "The governance request ID is invalid." });
    await expect(
      createGovernanceClient(vi.fn<DashboardFetch>(), () => {
        throw new Error("id factory");
      }).access(signal),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "The governance request ID could not be generated.",
    });
    await expect(
      createGovernanceClient(vi.fn<DashboardFetch>(), () => "request:one").classes(
        null as never,
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid", message: "The governance request is invalid." });
  });

  it("releases rejected response bodies before reporting the status problem", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const rejected = mockFetch(() => new Response(body, { status: 403 }));
    await expect(
      createGovernanceClient(rejected, () => "request:one").access(new AbortController().signal),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(cancel).toHaveBeenCalledOnce();

    const locked = new Response(new ReadableStream(), { status: 500 });
    locked.body?.getReader();
    await expect(
      createGovernanceClient(
        mockFetch(() => locked),
        () => "request:one",
      ).access(new AbortController().signal),
    ).rejects.toMatchObject({ code: "load", message: "The governance request was rejected." });
    await expect(
      createGovernanceClient(
        mockFetch(() => new Response(null, { status: 404 })),
        () => "request:one",
      ).access(new AbortController().signal),
    ).rejects.toMatchObject({ code: "load", message: "The governance request was rejected." });
  });

  it.each([200, 409, 500])(
    "keeps an abort after dispatch uncertain even with status %i",
    async (status) => {
      const controller = new AbortController();
      const fetchRequest = mockFetch(() => {
        controller.abort(new Error("cancelled after dispatch"));
        return new Response("private response", { status });
      });
      await expect(
        createGovernanceClient(fetchRequest, () => "request:one").access(controller.signal),
      ).rejects.toMatchObject({
        code: "uncertain",
        message: "The governance request was aborted after dispatch.",
      });
      expect(fetchRequest).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects each correlated mutation target when the server replies for another target", async () => {
    const badResponse = (kind: string, field: string): object => {
      const response = responseFor(kind);
      const other = (name: string, current: string) => (field === name ? `${name}:other` : current);
      if ("classroom" in response)
        return {
          ...response,
          classroom: {
            ...response.classroom,
            classId: other("classId", classId),
            centerId: other("centerId", centerId),
          },
        };
      if ("account" in response)
        return {
          ...response,
          account: {
            ...response.account,
            userId: other("userId", userId),
            centerId: other("centerId", centerId),
          },
        };
      if ("membership" in response)
        return {
          ...response,
          membership: {
            ...response.membership,
            userId: other("userId", userId),
            centerId: other("centerId", centerId),
            classId: other("classId", classId),
          },
        };
      if ("revocation" in response)
        return { ...response, revocation: { ...response.revocation, userId: "user:other" } };
      if ("preview" in response)
        return {
          ...response,
          preview: {
            ...response.preview,
            classId: other("classId", classId),
            centerId: other("centerId", centerId),
            expectedTeachingVersion: field === "expectedTeachingVersion" ? version : null,
          },
        };
      if (kind === "governance-class-import-confirm")
        return { ...response, classId: "class:other" };
      return { ...response, previewId: "preview:other" };
    };
    let field = "classId";
    const fetchRequest = mockFetch((_path, init) => {
      const request = readRequest(init);
      return new Response(JSON.stringify(badResponse(request.kind, field)));
    });
    const client = createGovernanceClient(fetchRequest, () => "request:one");
    const calls = [
      {
        call: () =>
          client.createClass(
            { centerId, classId, displayName: "New class", expectedVersion: null },
            signal,
          ),
        fields: ["centerId", "classId"],
      },
      {
        call: () =>
          client.renameClass(
            { centerId, classId, displayName: "Renamed", expectedVersion: version },
            signal,
          ),
        fields: ["centerId", "classId"],
      },
      {
        call: () =>
          client.createAccount(
            {
              centerId,
              userId,
              displayName: "Teacher",
              login: "teacher1",
              role: "teacher",
              classId: null,
              expectedVersion: null,
            },
            signal,
          ),
        fields: ["centerId", "userId"],
      },
      {
        call: () =>
          client.renameAccount(
            { centerId, userId, displayName: "Renamed", expectedVersion: version },
            signal,
          ),
        fields: ["centerId", "userId"],
      },
      {
        call: () =>
          client.changeAccountState(
            { centerId, userId, state: "disabled", expectedVersion: version },
            signal,
          ),
        fields: ["centerId", "userId"],
      },
      {
        call: () =>
          client.changeMembership(
            { centerId, classId, userId, state: "active", expectedVersion: null },
            signal,
          ),
        fields: ["centerId", "classId", "userId"],
      },
      {
        call: () => client.revokeSessions({ centerId, userId, expectedVersion: version }, signal),
        fields: ["userId"],
      },
      {
        call: () =>
          client.previewClassImport(
            { centerId, classId, expectedTeachingVersion: null, package: exchange },
            signal,
          ),
        fields: ["centerId", "classId", "expectedTeachingVersion"],
      },
      {
        call: () => client.confirmClassImport({ centerId, classId, previewId }, signal),
        fields: ["classId"],
      },
      {
        call: () => client.cancelClassImport({ centerId, classId, previewId }, signal),
        fields: ["previewId"],
      },
    ];
    for (const { call, fields } of calls) {
      for (const target of fields) {
        field = target;
        await expect(call()).rejects.toMatchObject({ code: "uncertain" });
      }
    }
  });

  it("cleans up aborted reads and covers the bounded serialization seam", async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const pending = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled += 1;
      },
    });
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const read = readGovernanceResponse(new Response(pending), 100, controller.signal);
    controller.abort(new Error("read aborted"));
    await expect(read).rejects.toThrow("read aborted");
    expect(cancelled).toBe(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(pending.locked).toBe(false);
    const preAborted = new AbortController();
    preAborted.abort(new Error("already aborted"));
    await expect(
      readGovernanceResponse(new Response(null), 100, preAborted.signal),
    ).rejects.toThrow("already aborted");
    await expect(readGovernanceResponse(new Response(null), 100, signal)).resolves.toBe("");
    const serialized = JSON.stringify({ text: "é" });
    const exactBytes = new TextEncoder().encode(serialized).byteLength;
    expect(serializeGovernanceRequest({ text: "é" }, exactBytes)).toBe(serialized);
    expect(() => serializeGovernanceRequest({ text: "é" }, exactBytes - 1)).toThrow(RangeError);
  });

  it("validates records and cursors for every paged operation", async () => {
    const fetchRequest = mockFetch((_path, init) => {
      const request = readRequest(init);
      const response = responseFor(request.kind);
      if (request.kind === "governance-centers-query") {
        return new Response(
          JSON.stringify({
            ...response,
            requestId: request.requestId,
            items: [
              { centerId: id("center:1"), displayName: "Center", version },
              { centerId: id("center:2"), displayName: "Center 2", version },
            ],
            nextAfterId: null,
          }),
        );
      }
      if (request.kind === "governance-classes-query") {
        return new Response(
          JSON.stringify({
            ...response,
            requestId: request.requestId,
            items: [
              classRow("class:1", { displayName: "Class" }),
              classRow("class:2", { displayName: "Class 2" }),
            ],
            nextAfterId: null,
          }),
        );
      }
      if (request.kind === "governance-accounts-query") {
        return new Response(
          JSON.stringify({
            ...response,
            requestId: request.requestId,
            items: [
              accountRow("user:1", { displayName: "Teacher" }),
              accountRow("user:2", { displayName: "Teacher 2" }),
            ],
            nextAfterId: null,
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ...response,
          requestId: request.requestId,
          items: [
            { classId, centerId, userId: id("user:1"), role: "teacher", state: "active", version },
            { classId, centerId, userId: id("user:2"), role: "teacher", state: "active", version },
          ],
          nextAfterId: null,
        }),
      );
    });
    const client = createGovernanceClient(fetchRequest, () => "request:one");
    await client.centers({ afterId: null }, signal);
    await client.classes({ centerId, afterId: null }, signal);
    await client.accounts({ centerId, afterId: null }, signal);
    await client.memberships({ centerId, classId, afterId: null }, signal);
    await client.classes({ centerId, afterId: id("class") }, signal);

    const defaultIdFetch = mockFetch((_path, init) => {
      const request = readRequest(init);
      return new Response(
        JSON.stringify({ ...responseFor(request.kind), requestId: request.requestId }),
      );
    });
    await createGovernanceClient(defaultIdFetch).access(signal);
  });

  it("accepts binary-prefix ordering only with a terminal cursor", async () => {
    await expect(
      createGovernanceClient(classPageFetch(["a", "aa", "z"], null), () => "request:one").classes(
        { centerId, afterId: null },
        signal,
      ),
    ).resolves.toMatchObject({ nextAfterId: null });
    await expect(
      createGovernanceClient(classPageFetch(["aa", "a"], null), () => "request:one").classes(
        { centerId, afterId: null },
        signal,
      ),
    ).rejects.toMatchObject({ code: "load" });
    await expect(
      createGovernanceClient(classPageFetch(["a"], "z"), () => "request:one").classes(
        { centerId, afterId: null },
        signal,
      ),
    ).resolves.toMatchObject({ nextAfterId: "z" });
    await expect(
      createGovernanceClient(classPageFetch([], "a"), () => "request:one").classes(
        { centerId, afterId: null },
        signal,
      ),
    ).resolves.toMatchObject({ nextAfterId: "a" });
  });
});
