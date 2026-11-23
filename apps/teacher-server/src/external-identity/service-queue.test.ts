import { describe, expect, it, vi } from "vitest";
import { fixture, started, completion, completeStarted } from "./service.fixture.js";

describe("completion slot boundaries", () => {
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "falls back to sixteen slots for invalid limit %s",
    async (maxCompletions) => {
      const test = fixture({ maxCompletions });
      const release = Promise.withResolvers<undefined>();
      test.provider.pending = release.promise;
      const running = Array.from({ length: 16 }, () => completeStarted(test));
      await Promise.resolve(undefined);
      expect(test.provider.responses).toHaveLength(16);
      const queued = completeStarted(test);
      await Promise.resolve(undefined);
      expect(test.provider.responses).toHaveLength(16);
      release.resolve(undefined);
      await Promise.all([...running, queued]);
      expect(test.opened).toHaveLength(17);
    },
  );

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "uses the exact default wait for invalid timeout %s and removes expired waiters",
    async (completionWaitMs) => {
      vi.useFakeTimers();
      try {
        const test = fixture({ maxCompletions: 1, completionWaitMs });
        const release = Promise.withResolvers<undefined>();
        test.provider.pending = release.promise;
        const running = completeStarted(test);
        const rejected = expect(completeStarted(test)).rejects.toMatchObject({ code: "auth.busy" });
        await vi.advanceTimersByTimeAsync(7_999);
        expect(vi.getTimerCount()).toBe(1);
        expect(test.provider.responses).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        const next = completeStarted(test);
        release.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(test.provider.responses).toHaveLength(2);
        await Promise.all([running, next]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("counts a granted waiter against the limit until it finishes", async () => {
    const test = fixture({ maxCompletions: 1 });
    const firstRelease = Promise.withResolvers<undefined>();
    test.provider.pending = firstRelease.promise;
    const first = completeStarted(test);
    await Promise.resolve(undefined);
    const secondRelease = Promise.withResolvers<undefined>();
    test.provider.pending = secondRelease.promise;
    const second = completeStarted(test);
    firstRelease.resolve(undefined);
    await first;
    expect(test.provider.responses).toHaveLength(2);
    const third = completeStarted(test);
    await Promise.resolve(undefined);
    expect(test.provider.responses).toHaveLength(2);
    secondRelease.resolve(undefined);
    await Promise.all([second, third]);
    expect(test.opened).toHaveLength(3);
  });

  it("rejects an already expired flow before waiting for an occupied slot", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture({ maxCompletions: 1 });
      const release = Promise.withResolvers<undefined>();
      test.provider.pending = release.promise;
      const running = completeStarted(test);
      await Promise.resolve(undefined);
      const { response, request } = started(test);
      test.clock.value = response.expiresAt;
      const rejected = expect(
        test.service.complete(completion(response.flowId, request.state)),
      ).rejects.toMatchObject({ code: "auth.invalid" });
      await vi.advanceTimersByTimeAsync(8_000);
      await rejected;
      expect(test.provider.responses).toHaveLength(1);
      release.resolve(undefined);
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes a flow expiring exactly when granted and releases its slot", async () => {
    const test = fixture({ maxCompletions: 1 });
    const release = Promise.withResolvers<undefined>();
    test.provider.pending = release.promise;
    const running = completeStarted(test);
    await Promise.resolve(undefined);
    const { response, request } = started(test);
    const input = completion(response.flowId, request.state);
    const expired = expect(test.service.complete(input)).rejects.toMatchObject({
      code: "auth.invalid",
    });
    test.clock.value = response.expiresAt;
    release.resolve(undefined);
    await running;
    await expired;
    expect(test.provider.responses).toHaveLength(1);
    test.clock.value = "2026-10-05T10:00:00.000Z";
    await expect(test.service.complete(input)).rejects.toMatchObject({ code: "auth.invalid" });
    await expect(completeStarted(test)).resolves.toMatchObject({ kind: "external-authenticated" });
    expect(test.opened).toHaveLength(2);
  });
});
