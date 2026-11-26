import { afterEach, expect, it, vi } from "vitest";

import { ConnectionDiagnostics } from "./connection-diagnostics.boundary.js";
import { SessionPresence } from "./session-presence.js";
import { FIXTURE_CLOCK, FixtureIds, MemoryStateStore, RUN_TOKEN } from "./student.fixture.js";
import { LocalSession } from "./local-session.js";

afterEach(() => {
  vi.useRealTimers();
});

it("is busy while a heartbeat is in flight and idle once it settles", async () => {
  vi.useFakeTimers();
  const sent = Promise.withResolvers<undefined>();
  const heartbeat = vi.fn(() => sent.promise);
  const ids = new FixtureIds();
  const presence = new SessionPresence({
    aborted: () => false,
    closing: () => false,
    connection: new ConnectionDiagnostics({
      clock: FIXTURE_CLOCK,
      diagnostics: undefined,
      ids,
      localSession: new LocalSession(new MemoryStateStore(), ids, FIXTURE_CLOCK),
      reportToServer: () => false,
    }),
    heartbeat,
    token: () => Promise.resolve(RUN_TOKEN),
  });
  expect(presence.busy).toBe(false);
  presence.start();
  expect(presence.busy).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(heartbeat).toHaveBeenCalledWith(RUN_TOKEN);
  sent.resolve(undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(presence.busy).toBe(false);
  presence.stop();
  expect(vi.getTimerCount()).toBe(0);
});
