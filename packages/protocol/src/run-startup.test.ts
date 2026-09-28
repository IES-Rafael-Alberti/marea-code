import { describe, expect, it } from "vitest";

import { CanonicalRunEventSchema } from "./events.js";
import { RunStartupStateSchema, STARTUP_MESSAGE_ID, StudentRunSnapshotSchema } from "./runs.js";

describe("internal tutor startup protocol", () => {
  it("reserves one stable internal identity and explicit progress states", () => {
    expect(STARTUP_MESSAGE_ID).toBe("marea:tutor-startup");
    for (const state of ["pending", "started", "completed", "cancelled"]) {
      expect(RunStartupStateSchema.parse(state)).toBe(state);
    }
    for (const state of ["", "failed", null, 1])
      expect(RunStartupStateSchema.safeParse(state).success).toBe(false);
  });

  it("stores startup progress without student-message content", () => {
    const base = {
      eventType: "tutor-startup",
      eventId: "event:startup",
      occurredAt: "2026-09-08T00:00:00.000Z",
      sequence: 2,
    };
    for (const state of ["started", "completed", "cancelled"]) {
      const value = { ...base, state };
      expect(CanonicalRunEventSchema.parse(value)).toEqual(value);
      expect(Object.isFrozen(CanonicalRunEventSchema.parse(value))).toBe(true);
    }
    for (const value of [
      { ...base, state: "pending" },
      { ...base, state: "started", content: "Fake student input" },
      { ...base, state: "started", sequence: 0 },
      { ...base, state: "started", eventId: "bad/id" },
      { ...base, state: "started", occurredAt: "not-a-date" },
      { ...base, state: "started", extra: true },
    ])
      expect(CanonicalRunEventSchema.safeParse(value).success).toBe(false);
  });

  it("carries a bounded startup prompt without retrofitting legacy snapshots", () => {
    const prompt = {
      version: "prompt:one",
      content: "Internal exercise setup.",
      digest: `sha256:${"a".repeat(64)}`,
    };
    const legacy = {
      id: "snapshot:one",
      agentMode: "tutoring",
      modelAlias: "marea",
      prompt,
      didacticSkills: [],
      teacherToolPolicy: { version: "policy:one", restrictions: [] },
    };
    expect(StudentRunSnapshotSchema.parse(legacy)).toEqual(legacy);
    const value = { ...legacy, startup: prompt };
    const parsed = StudentRunSnapshotSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed.startup)).toBe(true);
    expect(
      StudentRunSnapshotSchema.safeParse({ ...legacy, startup: { ...prompt, content: "" } })
        .success,
    ).toBe(false);
    expect(
      StudentRunSnapshotSchema.safeParse({
        ...legacy,
        startup: { ...prompt, name: "private-layer" },
      }).success,
    ).toBe(false);
  });
});
