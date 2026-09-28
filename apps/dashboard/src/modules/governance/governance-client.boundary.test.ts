import { describe, expect, it, vi } from "vitest";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createGovernanceClient } from "./governance-client.boundary.js";
import { readGovernanceResponse } from "./governance-response.boundary.js";
import {
  mockFetch,
  readRequest,
  classRow,
  accountRow,
  centerId,
  classId,
  envelope,
  exchange,
  id,
  previewId,
  responseFor,
  setup,
  signal,
  userId,
  version,
} from "./governance-client.boundary.fixture.js";

describe("governance browser transport", () => {
  it("sends all 17 operations through fixed POST routes with inferred envelopes", async () => {
    const { calls, fetchRequest, client } = setup();
    await client.access(signal);
    await client.centers({ afterId: null }, signal);
    await client.classes({ centerId, afterId: null }, signal);
    await client.accounts({ centerId, afterId: null }, signal);
    await client.memberships({ centerId, classId, afterId: null }, signal);
    await client.classRevision({ centerId, classId }, signal);
    await client.createClass(
      { centerId, classId, displayName: "New class", expectedVersion: null },
      signal,
    );
    await client.renameClass(
      { centerId, classId, displayName: "Renamed", expectedVersion: version },
      signal,
    );
    await client.createAccount(
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
    );
    await client.renameAccount(
      { centerId, userId, displayName: "Renamed", expectedVersion: version },
      signal,
    );
    await client.changeAccountState(
      { centerId, userId, state: "disabled", expectedVersion: version },
      signal,
    );
    await client.changeMembership(
      { centerId, classId, userId, state: "active", expectedVersion: null },
      signal,
    );
    await client.revokeSessions({ centerId, userId, expectedVersion: version }, signal);
    await client.exportClass({ centerId, classId, expectedTeachingVersion: version }, signal);
    await client.previewClassImport(
      { centerId, classId, expectedTeachingVersion: null, package: exchange },
      signal,
    );
    await client.confirmClassImport({ centerId, classId, previewId }, signal);
    await client.cancelClassImport({ centerId, classId, previewId }, signal);

    expect(fetchRequest).toHaveBeenCalledTimes(17);
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/dashboard/governance/access",
      "/api/v1/dashboard/governance/centers",
      "/api/v1/dashboard/governance/classes",
      "/api/v1/dashboard/governance/accounts",
      "/api/v1/dashboard/governance/memberships",
      "/api/v1/dashboard/governance/class/revision",
      "/api/v1/dashboard/governance/class/create",
      "/api/v1/dashboard/governance/class/rename",
      "/api/v1/dashboard/governance/account/create",
      "/api/v1/dashboard/governance/account/rename",
      "/api/v1/dashboard/governance/account/state",
      "/api/v1/dashboard/governance/membership/change",
      "/api/v1/dashboard/governance/sessions/revoke",
      "/api/v1/dashboard/governance/class/export",
      "/api/v1/dashboard/governance/class/import/preview",
      "/api/v1/dashboard/governance/class/import/confirm",
      "/api/v1/dashboard/governance/class/import/cancel",
    ]);
    const first = readRequest(calls[0]?.init);
    expect(first).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "governance-access-query",
    });
    expect(
      calls.every(
        ({ init }) =>
          init.method === "POST" && init.credentials === "same-origin" && init.cache === "no-store",
      ),
    ).toBe(true);
    expect(
      calls.every(
        ({ init }) =>
          (init.headers as Record<string, string>).Accept === "application/json" &&
          (init.headers as Record<string, string>)["Content-Type"] === "application/json",
      ),
    ).toBe(true);
  });

  it("rejects invalid or reserved payloads before fetch and preserves stable IDs", async () => {
    const { fetchRequest, client } = setup();
    await expect(
      client.createClass({ centerId, classId, displayName: "", expectedVersion: null }, signal),
    ).rejects.toMatchObject({ code: "invalid", message: "The governance request is invalid." });
    await expect(
      client.classRevision({ centerId, classId, kind: "bad" } as never, signal),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "The governance request contains reserved fields.",
    });
    expect(fetchRequest).not.toHaveBeenCalled();
    await expect(
      client.createClass(
        { centerId, classId, displayName: "New class", expectedVersion: null },
        signal,
      ),
    ).resolves.toBeDefined();
    const sent = readRequest(fetchRequest.mock.calls[0]?.[1]);
    expect(sent).toMatchObject({ classId });
  });

  it("maps known status rejections and never reads their error body", async () => {
    const statuses = [400, 401, 403, 409, 413, 422, 503] as const;
    for (const status of statuses) {
      const fetchRequest = mockFetch(() => new Response("private error", { status }));
      const client = createGovernanceClient(fetchRequest, () => "request:one");
      const expected =
        status === 400 || status === 413
          ? "invalid"
          : status === 401 || status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : status === 422
                ? "skill-unavailable"
                : "unconfigured";
      await expect(
        client.renameClass(
          { centerId, classId, displayName: "Renamed", expectedVersion: version },
          signal,
        ),
      ).rejects.toMatchObject({ code: expected, message: "The governance request was rejected." });
    }
  });

  it("keeps post-dispatch mutation failures uncertain and does not resend", async () => {
    const fetchRequest = mockFetch(() => new Response("not json", { status: 500 }));
    const client = createGovernanceClient(fetchRequest, () => "request:one");
    await expect(
      client.renameClass(
        { centerId, classId, displayName: "Renamed", expectedVersion: version },
        signal,
      ),
    ).rejects.toMatchObject({ code: "uncertain", message: "The governance request was rejected." });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("classifies malformed or aborted mutation responses as uncertain", async () => {
    const malformed = mockFetch(() => new Response("not json"));
    await expect(
      createGovernanceClient(malformed, () => "request:one").renameClass(
        { centerId, classId, displayName: "Renamed", expectedVersion: version },
        signal,
      ),
    ).rejects.toMatchObject({ code: "uncertain", message: "The governance response is invalid." });
    expect(malformed).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const aborted = mockFetch(() => {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull() {
            controller.abort(new Error("response aborted"));
            return new Promise<void>(() => undefined);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream);
    });
    await expect(
      createGovernanceClient(aborted, () => "request:one").renameClass(
        { centerId, classId, displayName: "Renamed", expectedVersion: version },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "uncertain", message: "The governance response is invalid." });
  });

  it("keeps unknown query and mutation statuses definite by operation", async () => {
    const queryFetch = mockFetch(() => new Response("private", { status: 418 }));
    await expect(
      createGovernanceClient(queryFetch, () => "request:one").access(signal),
    ).rejects.toMatchObject({ code: "load" });

    const mutationFetch = mockFetch(() => new Response("private", { status: 418 }));
    await expect(
      createGovernanceClient(mutationFetch, () => "request:one").renameClass(
        { centerId, classId, displayName: "Renamed", expectedVersion: version },
        signal,
      ),
    ).rejects.toMatchObject({ code: "load" });
  });

  it("rejects a page that drifts scope, order, or its exclusive cursor", async () => {
    const cases = [
      {
        items: [
          {
            classId: id("class:2"),
            centerId: id("center:foreign"),
            displayName: "Other",
            version,
            operatorReady: true,
          },
        ],
        nextAfterId: "class:3",
      },
      {
        items: [
          { classId: id("class:2"), centerId, displayName: "Two", version, operatorReady: true },
          { classId: id("class:1"), centerId, displayName: "One", version, operatorReady: true },
        ],
        nextAfterId: "class:3",
      },
      {
        items: [
          { classId: id("class:1"), centerId, displayName: "One", version, operatorReady: true },
          {
            classId: id("class:1"),
            centerId,
            displayName: "Duplicate",
            version,
            operatorReady: true,
          },
        ],
        nextAfterId: "class:3",
      },
      {
        items: [
          { classId: id("class:1"), centerId, displayName: "One", version, operatorReady: true },
        ],
        nextAfterId: "class:1",
      },
    ];
    for (const { items, nextAfterId } of cases) {
      const fetchRequest = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              ...envelope,
              kind: "governance-classes-response",
              items,
              nextAfterId,
            }),
          ),
      );
      const client = createGovernanceClient(fetchRequest, () => "request:one");
      await expect(client.classes({ centerId, afterId: null }, signal)).rejects.toMatchObject({
        code: "load",
      });
    }
  });

  it("correlates both class-revision target identifiers", async () => {
    for (const target of ["centerId", "classId"]) {
      const fetchRequest = mockFetch(() => {
        const response = responseFor("governance-class-revision-query");
        return new Response(
          JSON.stringify({
            ...response,
            [target]: target === "centerId" ? "center:other" : "class:other",
          }),
        );
      });
      await expect(
        createGovernanceClient(fetchRequest, () => "request:one").classRevision(
          { centerId, classId },
          signal,
        ),
      ).rejects.toMatchObject({ code: "load" });
    }
  });

  it("rejects foreign rows in every scoped page", async () => {
    const fetchRequest = mockFetch((_path, init) => {
      const request = readRequest(init);
      const response = responseFor(request.kind);
      if (request.kind === "governance-classes-query") {
        return new Response(
          JSON.stringify({
            ...response,
            requestId: request.requestId,
            items: [classRow("class:1", { displayName: "Foreign", centerId: "center:other" })],
            nextAfterId: null,
          }),
        );
      }
      if (request.kind === "governance-accounts-query") {
        return new Response(
          JSON.stringify({
            ...response,
            requestId: request.requestId,
            items: [accountRow("user:1", { displayName: "Foreign", centerId: "center:other" })],
            nextAfterId: null,
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ...response,
          requestId: request.requestId,
          items: [
            {
              classId,
              centerId: "center:other",
              userId,
              role: "teacher",
              state: "active",
              version,
            },
          ],
          nextAfterId: null,
        }),
      );
    });
    const client = createGovernanceClient(fetchRequest, () => "request:one");
    await expect(client.classes({ centerId, afterId: null }, signal)).rejects.toMatchObject({
      code: "load",
    });
    await expect(client.accounts({ centerId, afterId: null }, signal)).rejects.toMatchObject({
      code: "load",
    });
    await expect(
      client.memberships({ centerId, classId, afterId: null }, signal),
    ).rejects.toMatchObject({ code: "load" });

    const foreignClass = mockFetch((_path, init) => {
      const request = readRequest(init);
      return new Response(
        JSON.stringify({
          protocolVersion: "0.1",
          requestId: request.requestId,
          kind: "governance-memberships-response",
          items: [
            { classId: "class:other", centerId, userId, role: "teacher", state: "active", version },
          ],
          nextAfterId: null,
        }),
      );
    });
    await expect(
      createGovernanceClient(foreignClass, () => "request:one").memberships(
        { centerId, classId, afterId: null },
        signal,
      ),
    ).rejects.toMatchObject({ code: "load" });
  });

  it("bounds streamed bytes and cancels readers on overflow or fatal UTF-8", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5"));
      },
      cancel() {
        cancelled += 1;
      },
    });
    await expect(readGovernanceResponse(new Response(stream), 4, signal)).rejects.toThrow(
      RangeError,
    );
    expect(cancelled).toBe(1);

    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.close();
      },
    });
    await expect(readGovernanceResponse(new Response(exact), 4, signal)).resolves.toBe("1234");

    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xc3));
        controller.enqueue(Uint8Array.of(0xa9));
        controller.close();
      },
    });
    await expect(readGovernanceResponse(new Response(split), 2, signal)).resolves.toBe("é");

    cancelled = 0;
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xff));
      },
      cancel() {
        cancelled += 1;
      },
    });
    await expect(readGovernanceResponse(new Response(malformed), 10, signal)).rejects.toThrow();
    expect(cancelled).toBe(1);
  });

  it("preserves a pre-dispatch abort without invoking fetch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));
    const fetchRequest = vi.fn<DashboardFetch>();
    const client = createGovernanceClient(fetchRequest, () => "request:one");
    await expect(
      client.renameClass(
        { centerId, classId, displayName: "Renamed", expectedVersion: version },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled before dispatch");
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
