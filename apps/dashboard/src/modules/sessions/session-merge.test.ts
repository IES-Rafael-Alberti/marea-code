import { expect, it } from "vitest";
import { CanonicalRunEventSchema, ClassSessionItemSchema } from "@marea/protocol";
import { NOW, SESSIONS } from "../evaluation/evaluation.fixture.js";
import { listedConnection, mergedEvents, uniqueRuns } from "./session-merge.js";

const row = (patch: object) =>
  ClassSessionItemSchema.parse({ ...SESSIONS.runs[0], classId: "class:one", ...patch });
const event = (sequence: number, version: string) =>
  CanonicalRunEventSchema.parse({
    eventType: "assistant-message",
    eventId: `event:${String(sequence)}:${version}`,
    sequence,
    occurredAt: NOW,
    content: version,
  });

it("keeps one row per session, the last listed winning", () => {
  expect(
    uniqueRuns([row({}), row({ projectDisplayName: "Newer" })]).map((r) => r.projectDisplayName),
  ).toEqual(["Newer"]);
  expect(uniqueRuns([])).toEqual([]);
});
it("merges a newer page into the known events by sequence", () => {
  expect(
    mergedEvents([event(1, "old"), event(2, "two")], [event(1, "new"), event(3, "three")]).map(
      (e) => [e.sequence, e.eventId],
    ),
  ).toEqual([
    [1, "event:1:new"],
    [2, "event:2:two"],
    [3, "event:3:three"],
  ]);
});
it("decides the freshness after a listing from the open session's history", () => {
  expect(listedConnection({ runId: null, connection: "loading" }, true)).toBe("current");
  expect(listedConnection({ runId: "run:one", connection: "current" }, true)).toBe("stale");
  expect(listedConnection({ runId: "run:one", connection: "loading" }, false)).toBe("loading");
  expect(listedConnection({ runId: "run:one", connection: "stale" }, undefined)).toBe("current");
});
