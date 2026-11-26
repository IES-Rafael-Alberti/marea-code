import { describe, expect, it, vi } from "vitest";
import { MAX_INSIGHTS_BYTES } from "@marea/protocol";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { student } from "../../test-support/teaching-integration.fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { fixture } from "./insights.fixture.js";
import { approve, capture, enabled, targetOf } from "./progress.fixture.js";
import { EducationalInsightsService } from "./service.js";
import { InsightsFailure } from "./model-output.boundary.js";
import type { ClassRouteLookup } from "./progress-notes.js";
import type { PrivateProviderRoute } from "../sessions/contracts.js";
import { recordNotesNotice } from "./notes-notice.js";

const tutorOnly: PrivateProviderRoute = {
  providerId: "synthetic-provider",
  model: "synthetic-tutor",
  budget: SYNTHETIC_ROUTE_BUDGET,
};
const route: PrivateProviderRoute = {
  ...tutorOnly,
  evaluation: { providerId: "synthetic-provider", model: "synthetic-reviewer" },
};

function notesFixture() {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  approve(f, captured);
  const key = targetOf(captured).key;
  const request = (kind: string, extra: object = {}) =>
    f.service.read(teacher, f.query({ kind, studentId: "s1", key, ...extra }));
  return { ...f, key, captured, request };
}

describe("teacher notes editing", () => {
  it("reads the whole notes text with a content revision", () => {
    const f = notesFixture();
    const read = f.service.notes.read("class:one", "s1", f.key);
    expect(read).toMatchObject({
      notes: "07/09/2026: Practice an empty collection next.",
      omitted: 0,
    });
    expect(read.revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(f.request("notes").data).toEqual(read);
    expect(() =>
      f.service.read(teacher, f.query({ kind: "notes", studentId: "s2", key: f.key })),
    ).toThrow("request.conflict");
    expect(() =>
      f.service.read(
        { ...teacher, userId: "t2" },
        f.query({ kind: "notes", studentId: "s1", key: f.key }),
      ),
    ).toThrow();
  });

  it("saves teacher-owned text, allows clearing it and reports the new length", () => {
    const f = notesFixture();
    const { revision } = f.service.notes.read("class:one", "s1", f.key);
    const before = f.progress.read("class:one", "s1").revision;
    expect(
      f.request("save-notes", { notes: "Rewritten summary.", expectedRevision: revision }).data,
    ).toEqual({
      ...f.service.notes.read("class:one", "s1", f.key),
      conflict: false,
    });
    expect(f.service.notes.read("class:one", "s1", f.key)).toMatchObject({
      notes: "Rewritten summary.",
      omitted: 0,
    });
    expect(f.service.notes.read("class:one", "s1", f.key).revision).not.toBe(revision);
    expect(f.progress.read("class:one", "s1").revision).not.toBe(before);
    expect(
      f.service.progress.overview("class:one", null).students[0]?.entries[0]?.notesLength,
    ).toBe(18);
    const saved = f.service.notes.read("class:one", "s1", f.key).revision;
    expect(f.request("save-notes", { notes: "", expectedRevision: saved }).data).toMatchObject({
      notes: "",
      conflict: false,
    });
    expect(f.database.readOne("SELECT memory, memory_run_id FROM marea_learning_progress")).toEqual(
      {
        memory: "",
        memory_run_id: "run:b",
      },
    );
  });

  it("refuses a stale save without writing and returns the current text to merge", () => {
    const f = notesFixture();
    const { revision } = f.service.notes.read("class:one", "s1", f.key);
    f.database.execute(
      "UPDATE marea_learning_progress SET memory = memory || char(10) || '08/09/2026: Appended meanwhile.'",
    );
    expect(
      f.request("save-notes", { notes: "Lost?", expectedRevision: revision }).data,
    ).toMatchObject({
      notes: "07/09/2026: Practice an empty collection next.\n08/09/2026: Appended meanwhile.",
      omitted: 0,
      conflict: true,
    });
    expect(f.service.notes.read("class:one", "s1", f.key).notes).toContain("Appended meanwhile.");
    // A level change that adds no note does not make the teacher's text stale.
    const current = f.service.notes.read("class:one", "s1", f.key).revision;
    f.database.execute("UPDATE marea_learning_progress SET level = 2, revision = 'moved'");
    expect(
      f.request("save-notes", { notes: "Kept.", expectedRevision: current }).data,
    ).toMatchObject({
      conflict: false,
    });
  });

  it("authorizes the save inside its transaction", () => {
    const f = notesFixture();
    const require = vi.spyOn(f.progress, "require");
    f.request("save-notes", {
      notes: "x",
      expectedRevision: f.service.notes.read("class:one", "s1", f.key).revision,
    });
    expect(require).toHaveBeenCalledTimes(2);
    const denied = vi.fn(() => {
      throw new Error("denied");
    });
    const { revision } = f.service.notes.read("class:one", "s1", f.key);
    expect(() => f.service.notes.save("class:one", "s1", f.key, "x", revision, denied)).toThrow(
      "denied",
    );
    expect(f.service.notes.read("class:one", "s1", f.key).revision).toBe(revision);
    expect(() =>
      f.service.read(
        { ...teacher, userId: "t2" },
        f.query({
          kind: "save-notes",
          studentId: "s1",
          key: f.key,
          notes: "x",
          expectedRevision: revision,
        }),
      ),
    ).toThrow();
  });

  it("shows only the newest lines of a text too long for one response", () => {
    const f = notesFixture();
    const line = "x".repeat(1000);
    const lines = Math.ceil(MAX_INSIGHTS_BYTES / 2 / 1002) + 10;
    f.database.execute("UPDATE marea_learning_progress SET memory = ?1", [
      Array.from({ length: lines }, () => line).join("\n"),
    ]);
    const read = f.service.notes.read("class:one", "s1", f.key);
    expect(read.omitted).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(read.notes))).toBeLessThanOrEqual(
      MAX_INSIGHTS_BYTES / 2,
    );
    expect(read.notes.length + read.omitted).toBe(lines * 1001 - 1);
  });
});

describe("teacher summary proposals", () => {
  function proposals(classRoute = vi.fn<ClassRouteLookup>(() => route)) {
    const f = notesFixture();
    const service = new EducationalInsightsService(
      f.database,
      { now: () => NOW },
      { resolve: () => undefined },
      {},
      { classRoute, contextWindow: () => Promise.resolve(undefined) },
    );
    const generate = vi.spyOn(service.inference, "generate");
    const propose = async () =>
      (await service.read(teacher, f.query({ kind: "propose-notes", studentId: "s1", key: f.key }))
        .data) as object;
    return { ...f, service, generate, propose, classRoute };
  }

  it("asks the class's evaluation model and saves nothing", async () => {
    const f = proposals();
    f.generate.mockResolvedValueOnce({ summary: "Proposed summary." });
    expect(await f.propose()).toEqual({ proposal: "Proposed summary.", failure: null });
    expect(f.classRoute).toHaveBeenCalledWith(teacher.userId, "class:one");
    expect(f.generate.mock.calls[0]?.slice(0, 4)).toEqual([
      {
        providerId: "synthetic-provider",
        model: "synthetic-reviewer",
        budget: SYNTHETIC_ROUTE_BUDGET.evaluation,
        inputTokenCeiling: SYNTHETIC_ROUTE_BUDGET.inputTokenCeiling,
      },
      "notes-proposal:class:one:2026-09-07",
      expect.stringContaining("Propón un resumen breve"),
      { notes: "07/09/2026: Practice an empty collection next." },
    ]);
    expect(f.service.notes.read("class:one", "s1", f.key).notes).toBe(
      "07/09/2026: Practice an empty collection next.",
    );
  });

  it("uses the tutoring model when the route has no separate evaluation model", async () => {
    const f = proposals(vi.fn<ClassRouteLookup>(() => tutorOnly));
    f.generate.mockResolvedValueOnce({ summary: "S." });
    await f.propose();
    expect(f.generate.mock.calls[0]?.[0]).toMatchObject({ model: "synthetic-tutor" });
  });

  it("reports closed failure codes and does not ask about empty notes", async () => {
    const f = proposals();
    f.generate.mockRejectedValueOnce(new InsightsFailure("budget"));
    expect(await f.propose()).toEqual({ proposal: null, failure: "budget" });
    f.generate.mockRejectedValueOnce(new Error("socket"));
    expect(await f.propose()).toEqual({ proposal: null, failure: "provider" });
    f.classRoute.mockReturnValueOnce(undefined);
    expect(await f.propose()).toEqual({ proposal: null, failure: "unconfigured" });
    f.database.execute("UPDATE marea_learning_progress SET memory = '  '");
    expect(await f.propose()).toEqual({ proposal: null, failure: "empty" });
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("is unconfigured for a class route without budget", async () => {
    const f = proposals(vi.fn<ClassRouteLookup>(() => ({ providerId: "p", model: "m" })));
    expect(await f.propose()).toEqual({ proposal: null, failure: "unconfigured" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("is unconfigured without class routes", async () => {
    const f = notesFixture();
    const result = await f.service.read(
      teacher,
      f.query({ kind: "propose-notes", studentId: "s1", key: f.key }),
    ).data;
    expect(result).toEqual({ proposal: null, failure: "unconfigured" });
  });
});

describe("session start notes", () => {
  it("records a dashboard notice when the notes were shortened and clears it on save", async () => {
    const f = notesFixture();
    f.database.execute("UPDATE marea_learning_progress SET memory = ?1", [
      `01/09/2026: ${"x".repeat(9000)}\n07/09/2026: Recent note.`,
    ]);
    await f.progress.prepare(f.captured, student);
    const next = capture(f);
    expect(next.snapshot.prompt.content).toContain(
      `Notas de aprendizaje revisadas:\n${targetOf(next).skillId}/C1:\n07/09/2026: Recent note.`,
    );
    expect(next.snapshot.prompt.content).toContain("07/09/2026: Recent note.");
    expect(next.snapshot.prompt.content).not.toContain("x".repeat(9000));
    expect(f.service.progress.overview("class:one", null).students[0]).toMatchObject({
      id: "s1",
      notesNotice: { sessionDate: "07/09/2026", shortened: "trimmed" },
    });
    const { revision } = f.service.notes.read("class:one", "s1", f.key);
    f.service.notes.save("class:one", "s1", f.key, "Short.", revision, () => undefined);
    expect(f.service.progress.overview("class:one", null).students[0]?.notesNotice).toBeNull();
    // The stored notes are what the teacher saved; the shortened text was only for that session.
    expect(f.database.readOne("SELECT memory FROM marea_learning_progress")?.memory).toBe("Short.");
    // Another class's notice, or a record of another shape, is not shown.
    recordNotesNotice(f.database, "s1", {
      classId: "class:two",
      sessionDate: "07/09/2026",
      shortened: "trimmed",
    });
    expect(f.service.progress.overview("class:one", null).students[0]?.notesNotice).toBeNull();
    f.database.execute(
      "UPDATE marea_metadata SET value = '{}' WHERE key = 'learning-notes-notice:s1'",
    );
    expect(f.service.progress.overview("class:one", null).students[0]?.notesNotice).toBeNull();
  });

  it("prepares a first session before its progress rows exist and records no notice when notes fit", async () => {
    const f = fixture();
    enabled(f);
    await expect(f.progress.prepare(capture(fixture()), student)).resolves.toBeUndefined();
    const g = notesFixture();
    capture(g);
    expect(
      g.database.readOne("SELECT 1 FROM marea_metadata WHERE key LIKE 'learning-notes-notice:%'"),
    ).toBeUndefined();
    expect(f.database.readAll("SELECT 1 FROM marea_learning_progress")).toHaveLength(0);
  });

  it("prepares nothing outside adaptive tutoring", async () => {
    const f = fixture();
    const read = vi.spyOn(f.database, "readOne");
    await f.progress.prepare(capture(f), student);
    expect(read.mock.calls.some(([sql]) => sql.startsWith("SELECT memory"))).toBe(false);
  });

  it("prepares a summary for the same notes the capture then uses", async () => {
    const f = notesFixture();
    const long = `01/09/2026: ${"x".repeat(9000)}`;
    f.database.execute("UPDATE marea_learning_progress SET memory = ?1", [long]);
    const generate = vi
      .spyOn(f.service.inference, "generate")
      .mockResolvedValue({ summary: "Resumen breve." });
    await f.progress.prepare({ ...f.captured, providerRoute: route }, student);
    expect(generate.mock.calls[0]?.[1]).toBe("notes-session:s1:2026-09-07");
    expect(generate.mock.calls[0]?.[3]).toEqual({
      notes: `${targetOf(f.captured).skillId}/C1:\n${long}`,
    });
    expect(capture(f).snapshot.prompt.content).toContain(
      "Notas de aprendizaje revisadas:\nResumen breve.",
    );
    expect(f.service.progress.overview("class:one", null).students[0]?.notesNotice).toEqual({
      sessionDate: "07/09/2026",
      shortened: "summarized",
    });
  });
});
