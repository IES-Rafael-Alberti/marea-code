import { expect, it, vi } from "vitest";
import { SessionExportQuerySchema } from "@marea/protocol";
import { setup, NOW } from "../../test-support/history-fixture.js";
import { teacher, student } from "../../test-support/teaching-integration.fixture.js";
import {
  SqliteSessionExportRepository,
  exportUsage,
} from "../platform/persistence/sqlite-session-export.js";
import { SessionExportService } from "./service.boundary.js";
import { csvRow, sessionMarkdown, sessionSummary } from "./render.js";
import { addTraceEvent, completeTurn, encode } from "../observability/observability.fixture.js";

function files(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes);
  const result = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18),
      length = buffer.readUInt16LE(offset + 26);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + length);
    result.set(name, buffer.toString("utf8", offset + 30 + length, offset + 30 + length + size));
    offset += 30 + length + size;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  expect(buffer.readUInt32LE(buffer.length - 22)).toBe(0x06054b50);
  expect(buffer.readUInt16LE(buffer.length - 12)).toBe(result.size);
  return result;
}
it("exports only authorized sessions, applies all filters and rechecks membership", () => {
  const { database } = setup();
  const repository = new SqliteSessionExportRepository(database);
  const read = (q: object = {}) =>
    repository.read(teacher, SessionExportQuerySchema.parse({ identities: "names", ...q }));
  try {
    expect(read().map((s) => s.runId)).toEqual(["run:older", "run:a", "run:b"]);
    expect(
      read({
        runId: "run:a",
        studentId: "s1",
        classId: "class:one",
        from: NOW,
        until: "2026-09-08T00:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(read({ until: NOW }).map((s) => s.runId)).toEqual(["run:older"]);
    expect(read({ from: "2026-09-08T00:00:00.000Z" })).toEqual([]);
    for (const q of [{ studentId: "s2" }, { classId: "class:two" }]) expect(read(q)).toEqual([]);
    for (const runId of ["run:missing", "run:c"])
      expect(() => read({ runId })).toThrow(expect.objectContaining({ status: 404 }));
    expect(repository.students(teacher)).toEqual([{ id: "s1", name: "s1", classId: "class:one" }]);
    expect(() => repository.students(student)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() =>
      repository.read(student, SessionExportQuerySchema.parse({ identities: "names" })),
    ).toThrow(expect.objectContaining({ status: 403 }));
    database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id='t1'");
    expect(read()).toEqual([]);
    expect(repository.students(teacher)).toEqual([]);
  } finally {
    database.close();
  }
});
it("produces readable conversations, structured content, safe CSV and scoped pseudonyms", () => {
  const { database } = setup();
  const service = new SessionExportService(new SqliteSessionExportRepository(database));
  try {
    completeTurn(database);
    addTraceEvent(database, 8, {
      eventType: "tool-started",
      messageId: "message:3",
      callId: "call:1",
      name: "write",
      target: "main.py",
      arguments: "print('á')",
      truncated: true,
    });
    addTraceEvent(database, 9, {
      eventType: "tool-finished",
      messageId: "message:3",
      callId: "call:1",
      result: "created",
      failed: false,
      truncated: false,
    });
    const zip = files(service.download(teacher, encode({ identities: "names", runId: "run:a" })));
    expect(Object.fromEntries(zip)).toMatchSnapshot("complete named export format");
    expect([...zip.keys()]).toEqual([
      "README.txt",
      "sessions.csv",
      "events.jsonl",
      "usage.jsonl",
      "conversations/session-1.md",
    ]);
    expect(zip.get("conversations/session-1.md")).toContain("    Write a Python greeting");
    expect(zip.get("conversations/session-1.md")).toContain("[Content was truncated at capture.]");
    expect(zip.get("conversations/session-1.md")).toContain("    print('á')");
    expect(zip.get("conversations/session-1.md")).toContain("COMPLETED");
    expect(zip.get("events.jsonl")).toContain('"callId":"call:1"');
    expect(zip.get("README.txt")).toContain("NOT an anonymous dataset");
    expect(zip.get("sessions.csv")).toContain('"available"');
    const pseudo = files(service.download(teacher, encode({ identities: "pseudonyms" })));
    expect(Object.fromEntries(pseudo)).toMatchSnapshot("complete pseudonym export format");
    const csv = pseudo.get("sessions.csv") ?? "";
    expect(csv).not.toContain('"s1"');
    expect(csv).toContain('"student-1"');
    expect(csv).toContain('"project-3"');
    expect(pseudo.get("conversations/session-1.md")).toContain("class-1");
    expect(pseudo.get("events.jsonl")).not.toContain('"studentId":"s1"');
    expect(csvRow(["=SUM(A1)", " +cmd", "\n@cmd", 'hello,"friend"', null, 3])).toBe(
      '"\'=SUM(A1)","\' +cmd","\'\n@cmd","hello,""friend""",,"3"',
    );
    for (const input of [
      new Uint8Array([0xff]),
      encode({ identities: "none" }),
      encode({ identities: "names", from: NOW, until: NOW }),
    ])
      expect(() => service.download(teacher, input)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    expect(service.students(teacher)).toHaveLength(1);
  } finally {
    database.close();
  }
});
it("marks unknown usage and retains units instead of treating reservations as actual spending", () => {
  const row = {
    request_id: "r",
    attempt: 1,
    state: "settled",
    purpose: "tutoring",
    input_tokens: 2,
    output_tokens: 3,
    cost_units: 4,
    cost_unit: "nano-USD",
    created_at: NOW,
    settled_at: NOW,
  };
  expect(exportUsage(row)).toEqual({
    requestId: "r",
    attempt: 1,
    purpose: "tutoring",
    state: "settled",
    inputTokens: 2,
    outputTokens: 3,
    costUnits: 4,
    costUnit: "nano-USD",
    startedAt: NOW,
    endedAt: NOW,
  });
  expect(exportUsage({ ...row, state: "unknown", settled_at: null })).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    costUnits: null,
    endedAt: null,
  });
  const { database } = setup();
  try {
    const session = new SqliteSessionExportRepository(database).read(
      teacher,
      SessionExportQuerySchema.parse({ identities: "names", runId: "run:b" }),
    )[0];
    if (!session) throw new Error("fixture");
    expect(
      sessionSummary({
        ...session,
        usage: [exportUsage(row), exportUsage({ ...row, state: "unknown" })],
      }),
    ).toContain('"2","1","2","3"');
    expect(
      sessionMarkdown({
        ...session,
        events: [
          addTraceEvent(
            database,
            3,
            {
              eventType: "tool-finished",
              messageId: "m",
              callId: "c",
              failed: true,
              result: "denied",
              truncated: false,
            },
            "run:b",
          ),
        ],
      }),
    ).toContain("FAILED");
  } finally {
    database.close();
  }
});
it("rejects oversized selections before loading content", () => {
  const { database } = setup();
  const repository = new SqliteSessionExportRepository(database);
  const q = SessionExportQuerySchema.parse({ identities: "names" });
  try {
    const original = database.readAll.bind(database);
    const read = vi
      .spyOn(database, "readAll")
      .mockImplementation((sql, args) =>
        sql.startsWith("SELECT runs.*")
          ? Array.from({ length: 101 }, () => ({}))
          : original(sql, args),
      );
    expect(() => repository.read(teacher, q)).toThrow(expect.objectContaining({ status: 413 }));
    read.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS events") ? [{ events: 20001, bytes: 0 }] : original(sql, args),
    );
    expect(() => repository.read(teacher, q)).toThrow(expect.objectContaining({ status: 413 }));
    read.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS events")
        ? [{ events: 1, bytes: 33 * 1024 * 1024 }]
        : original(sql, args),
    );
    expect(() => repository.read(teacher, q)).toThrow(expect.objectContaining({ status: 413 }));
    read.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS events") ? [] : original(sql, args),
    );
    expect(() => repository.read(teacher, q)).toThrow(expect.objectContaining({ status: 503 }));
  } finally {
    vi.restoreAllMocks();
    database.close();
  }
});

it("bounds student choices and usage, and writes settled costs and attempts to both machine formats", () => {
  const { database } = setup();
  const repository = new SqliteSessionExportRepository(database);
  const service = new SessionExportService(repository);
  try {
    const read = database.readOne.bind(database);
    const spy = vi.spyOn(database, "readOne");
    const q = SessionExportQuerySchema.parse({ identities: "names" });
    spy.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS attempts") ? { attempts: 20001 } : read(sql, args),
    );
    expect(() => repository.read(teacher, q)).toThrow(expect.objectContaining({ status: 413 }));
    spy.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS attempts") ? undefined : read(sql, args),
    );
    expect(() => repository.read(teacher, q)).toThrow(expect.objectContaining({ status: 503 }));
    spy.mockRestore();
    const all = database.readAll.bind(database);
    const students = vi
      .spyOn(database, "readAll")
      .mockImplementation((sql, args) =>
        sql.includes("SELECT DISTINCT") ? Array.from({ length: 2001 }, () => ({})) : all(sql, args),
      );
    expect(() => repository.students(teacher)).toThrow(expect.objectContaining({ status: 413 }));
    students.mockRestore();
    database.execute("INSERT INTO marea_usage_accounts VALUES('run:a','tutoring',?1,?2)", [
      JSON.stringify({ costUnit: "nano-USD" }),
      NOW,
    ]);
    database.execute(
      "INSERT INTO marea_usage_attempts VALUES('attempt','run:a','tutoring','request',1,'settled',2,3,4,?1,?1)",
      [NOW],
    );
    const zip = files(service.download(teacher, encode({ identities: "names", runId: "run:a" })));
    expect(Object.fromEntries(zip)).toMatchSnapshot("exported usage records and cost summary");
    expect(zip.get("usage.jsonl")).toContain('"costUnits":4,"costUnit":"nano-USD"');
    expect(zip.get("sessions.csv")).toContain('{""nano-USD"":4}');
    const session = repository.read(
      teacher,
      SessionExportQuerySchema.parse({ identities: "names", runId: "run:a" }),
    )[0];
    if (!session) throw new Error("fixture");
    const attempt = session.usage[0];
    if (!attempt) throw new Error("fixture");
    expect(
      sessionSummary({ ...session, usage: [attempt, attempt, { ...attempt, outputTokens: null }] }),
    ).toContain('{""nano-USD"":12}');
  } finally {
    vi.restoreAllMocks();
    database.close();
  }
});
