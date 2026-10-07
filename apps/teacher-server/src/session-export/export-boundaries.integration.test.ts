import { expect, it, vi } from "vitest";
import { SessionExportQuerySchema } from "@marea/protocol";
import { setup, NOW } from "../../test-support/history-fixture.js";
import { teacher } from "../../test-support/teaching-integration.fixture.js";
import {
  SqliteSessionExportRepository,
  exportUsage,
} from "../platform/persistence/sqlite-session-export.js";
import { SessionExportService } from "./service.boundary.js";
import { SessionExportError } from "./contracts.js";
import { csvRow, sessionSummary, sessionMarkdown } from "./render.js";
import { addTraceEvent, encode } from "../observability/observability.fixture.js";
it("accepts exact selection limits and binds each aggregate to the selected session", () => {
  const { database } = setup();
  const repository = new SqliteSessionExportRepository(database);
  try {
    const q = SessionExportQuerySchema.parse({ identities: "names", runId: "run:a" });
    const all = database.readAll.bind(database),
      one = database.readOne.bind(database);
    const reads = vi.spyOn(database, "readAll"),
      counts = vi.spyOn(database, "readOne");
    repository.read(teacher, SessionExportQuerySchema.parse({ identities: "names" }));
    expect(
      reads.mock.calls
        .filter(([sql]) => sql.includes("COUNT(*) AS events"))
        .map(([, args]) => args),
    ).toEqual([["run:older"], ["run:a"], ["run:b"]]);
    expect(
      counts.mock.calls
        .filter(([sql]) => sql.includes("COUNT(*) AS attempts"))
        .map(([, args]) => args),
    ).toEqual([["run:older"], ["run:a"], ["run:b"]]);
    reads.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS events")
        ? [{ bytes: 32 * 1024 * 1024, events: 20000 }]
        : all(sql, args),
    );
    counts.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS attempts") ? { attempts: 20000 } : one(sql, args),
    );
    expect(repository.read(teacher, q)).toHaveLength(1);
    counts.mockRestore();
    reads.mockRestore();
    const row = database.readOne(
      "SELECT runs.*,users.display_name AS student_name,classes.display_name AS class_name FROM marea_runs runs JOIN marea_users users ON users.id=runs.student_id JOIN marea_classes classes ON classes.id=runs.class_id WHERE runs.id='run:a'",
    );
    if (!row) throw new Error("fixture");
    vi.spyOn(database, "readAll").mockImplementation((sql, args) =>
      sql.startsWith("SELECT runs.*")
        ? Array.from({ length: 100 }, () => row)
        : sql.includes("SELECT DISTINCT")
          ? Array.from({ length: 2000 }, () => ({
              student_id: "s",
              class_id: "c",
              display_name: "Student",
            }))
          : all(sql, args),
    );
    expect(
      repository.read(teacher, SessionExportQuerySchema.parse({ identities: "names" })),
    ).toHaveLength(100);
    expect(repository.students(teacher)).toHaveLength(2000);
  } finally {
    vi.restoreAllMocks();
    database.close();
  }
});
it("retains partial usage, breach accounting, progress messages and safe CSV text", () => {
  const { database } = setup();
  try {
    const repository = new SqliteSessionExportRepository(database);
    const session = repository.read(
      teacher,
      SessionExportQuerySchema.parse({ identities: "names", runId: "run:a" }),
    )[0];
    if (!session) throw new Error("fixture");
    const row = {
      request_id: "r",
      attempt: 1,
      state: "breached",
      purpose: "tutoring",
      input_tokens: 2,
      output_tokens: 3,
      cost_units: 4,
      cost_unit: "units",
      created_at: NOW,
      settled_at: NOW,
    };
    expect(exportUsage(row).costUnits).toBe(4);
    const progress = addTraceEvent(database, 3, {
      eventType: "assistant-progress",
      messageId: "m",
      truncated: false,
      content: "Progress text",
    });
    const failure = addTraceEvent(database, 4, {
      eventType: "turn-failed",
      messageId: "m",
      category: "provider",
      retryable: false,
    });
    expect(sessionMarkdown({ ...session, events: [progress] })).toContain("    Progress text");
    const summary = sessionSummary({
      ...session,
      events: [failure],
      usage: [
        exportUsage(row),
        { ...exportUsage(row), costUnit: "missing-units", costUnits: null },
      ],
    });
    expect(summary).toContain('{""units"":4}');
    expect(summary).not.toContain("missing-units");
    expect(summary).toContain(',"1","not captured"');
    expect(csvRow(["safe\ncontinued"])).toBe('"safe\ncontinued"');
    expect(new SessionExportError(400).message).toBe("Session export unavailable.");
  } finally {
    database.close();
  }
});
it("assigns distinct pseudonyms across people and classes and separates multiple usage rows", () => {
  const { database } = setup();
  try {
    const repository = new SqliteSessionExportRepository(database);
    const original = repository.read(
      teacher,
      SessionExportQuerySchema.parse({ identities: "names", runId: "run:a" }),
    )[0];
    if (!original) throw new Error("fixture");
    const usage = {
      requestId: "r",
      attempt: 1,
      state: "settled",
      purpose: "tutoring",
      inputTokens: 2,
      outputTokens: 3,
      costUnits: 4,
      costUnit: "units",
      startedAt: NOW,
      endedAt: NOW,
    };
    const sessions = [
      { ...original, usage: [usage, { ...usage, attempt: 2 }] },
      { ...original, studentId: "other", classId: "other", usage: [] },
    ];
    const service = new SessionExportService({ read: () => sessions, students: () => [] });
    const bytes = service.download(teacher, encode({ identities: "pseudonyms" }));
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"studentId":"student-2","studentName":"student-2"');
    expect(text).toContain('"classId":"class-2"');
    expect(text).toContain(
      '"endedAt":"2026-09-07T12:00:00.000Z"}\n{"runId":"session-1","requestId":"r","attempt":2',
    );
  } finally {
    database.close();
  }
});
