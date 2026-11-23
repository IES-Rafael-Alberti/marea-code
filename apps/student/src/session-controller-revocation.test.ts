import { EventIdSchema } from "@marea/protocol";
import { expect, it, vi } from "vitest";
import { StudentHttpError } from "./http-error.js";
import { setFixtureLeaseExpiry, replaceFixtureRun } from "./session-test.fixture.js";
import { createFixtureController } from "./student.fixture.js";

it.each([new Error("offline"), new StudentHttpError(503, "server.error", true)])(
  "propagates unrelated renewal failures",
  async (error) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    setFixtureLeaseExpiry(fixture.state);
    fixture.server.renewLease = () => Promise.reject(error);
    await expect(fixture.controller.modelRunToken()).rejects.toBe(error);
    expect(fixture.server.openRequests).toHaveLength(1);
  },
);

it.each(["missing", "opening", "no-reason"])(
  "rejects revoked lease recovery after state becomes %s",
  async (scenario) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    setFixtureLeaseExpiry(fixture.state);
    fixture.server.renewLease = () => {
      replaceFixtureRun(
        fixture.state,
        scenario === "missing"
          ? null
          : {
              phase: scenario === "opening" ? "opening" : "closing",
              closeReason: null,
            },
      );
      return Promise.reject(new StudentHttpError(409, "run.unavailable", false));
    };
    await expect(fixture.controller.modelRunToken()).rejects.toThrow(
      scenario === "no-reason"
        ? "The pending run close has no reason."
        : "The run changed while its revoked lease was being recovered.",
    );
    expect(fixture.server.openRequests).toHaveLength(1);
  },
);

it.each([false, true])(
  "recovers a closing run for pending delivery, missing renewed token=$missingToken",
  async (missingToken) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    await fixture.localSession.appendEvent("event:close", (sequence, occurredAt) => ({
      eventId: EventIdSchema.parse("event:close"),
      eventType: "run-activated",
      sequence,
      occurredAt,
    }));
    const append = vi.spyOn(fixture.server, "appendRunEvents");
    append.mockRejectedValueOnce(new StudentHttpError(409, "run.unavailable", false));
    if (missingToken) {
      const beginClose = fixture.localSession.beginClose.bind(fixture.localSession);
      vi.spyOn(fixture.localSession, "beginClose").mockImplementation(async (reason) => {
        const run = await beginClose(reason);
        return { ...run, runToken: null };
      });
      await expect(fixture.controller.close()).rejects.toThrow(
        "The active run token is unavailable.",
      );
      expect(append).toHaveBeenCalledTimes(1);
      expect(fixture.state.state.run?.closeReason).toBe("student-exit");
    } else {
      await fixture.controller.close();
      expect(append).toHaveBeenCalledTimes(2);
      expect(append.mock.calls[1]?.[1]).toEqual(append.mock.calls[0]?.[1]);
      // A server-confirmed close clears the local run: the server holds the history.
      expect(fixture.state.state.run).toBeNull();
    }
    expect(fixture.server.openRequests).toHaveLength(2);
  },
);
