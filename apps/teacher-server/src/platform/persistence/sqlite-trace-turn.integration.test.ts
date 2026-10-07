import { expect, it, vi } from "vitest";
import {
  observabilityFixture,
  completeTurn,
  addTraceEvent,
} from "../../observability/observability.fixture.js";
import { readTraceTurn } from "./sqlite-trace-turn.js";
import { USAGE_POLICY } from "../../../test-support/usage-fixture.js";
import { NOW } from "../../../test-support/history-fixture.js";
it("reads only the selected completed turn and its matching usage, including old clients without a start", () => {
  const f = observabilityFixture();
  try {
    expect(
      readTraceTurn(f.database, { runId: "missing", through: 1, attempts: 0 }),
    ).toBeUndefined();
    addTraceEvent(f.database, 3, { eventType: "turn-ended", messageId: "old", state: "completed" });
    expect(
      readTraceTurn(f.database, { runId: "run:a", through: 3, attempts: 0 })?.events,
    ).toHaveLength(1);
    completeTurn(f.database, 4);
    completeTurn(f.database, 9);
    f.database.execute("INSERT INTO marea_usage_accounts VALUES('run:a','tutoring',?1,?2)", [
      JSON.stringify(USAGE_POLICY),
      NOW,
    ]);
    f.database.execute(
      "INSERT INTO marea_usage_attempts VALUES('attempt','run:a','tutoring','request:4',1,'settled',12,8,20,?1,?1)",
      [NOW],
    );
    const turn = readTraceTurn(f.database, { runId: "run:a", through: 8, attempts: 0 });
    expect(turn?.events.map((e) => e.sequence)).toEqual([4, 5, 6, 7, 8]);
    expect(turn?.usage).toMatchObject([
      { requestId: "request:4", inputTokens: 12, outputTokens: 8, costUnits: 20 },
    ]);
    expect(readTraceTurn(f.database, { runId: "run:a", through: 13, attempts: 0 })?.usage).toEqual(
      [],
    );
  } finally {
    f.database.close();
  }
});
it("bounds event content and usage before constructing an external payload", () => {
  const f = observabilityFixture();
  try {
    completeTurn(f.database);
    const item = { runId: "run:a", through: 7, attempts: 0 };
    const read = f.database.readOne.bind(f.database);
    const one = vi.spyOn(f.database, "readOne");
    for (const size of [
      { count: 1001, bytes: 0 },
      { count: 1, bytes: 131073 },
    ]) {
      one.mockImplementation((sql, args) =>
        sql.includes("COUNT(*) AS count") ? size : read(sql, args),
      );
      expect(() => readTraceTurn(f.database, item)).toThrow(
        expect.objectContaining({ code: "payload-too-large" }),
      );
    }
    one.mockRestore();
    const all = f.database.readAll.bind(f.database);
    vi.spyOn(f.database, "readAll").mockImplementation((sql, args) =>
      sql.includes("SELECT attempts.*") ? Array.from({ length: 1001 }, () => ({})) : all(sql, args),
    );
    expect(() => readTraceTurn(f.database, item)).toThrow(
      expect.objectContaining({ code: "payload-too-large" }),
    );
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});

it("accepts exact payload bounds and scopes size queries to the queued turn", () => {
  const f = observabilityFixture();
  try {
    completeTurn(f.database);
    const original = f.database.readOne.bind(f.database);
    const read = vi.spyOn(f.database, "readOne");
    readTraceTurn(f.database, { runId: "run:a", through: 7, attempts: 0 });
    expect(read.mock.calls.find(([sql]) => sql.includes("COUNT(*) AS count"))?.[1]).toEqual([
      "run:a",
      3,
      7,
    ]);
    read.mockImplementation((sql, args) =>
      sql.includes("COUNT(*) AS count") ? { count: 1000, bytes: 131072 } : original(sql, args),
    );
    const all = f.database.readAll.bind(f.database);
    const usage = {
      request_id: "request:3",
      attempt: 1,
      state: "settled",
      purpose: "tutoring",
      input_tokens: 2,
      output_tokens: 3,
      cost_units: 4,
      cost_unit: "units",
      created_at: NOW,
      settled_at: NOW,
    };
    vi.spyOn(f.database, "readAll").mockImplementation((sql, args) =>
      sql.includes("SELECT attempts.*")
        ? Array.from({ length: 1000 }, () => usage)
        : all(sql, args),
    );
    expect(
      readTraceTurn(f.database, { runId: "run:a", through: 7, attempts: 0 })?.usage,
    ).toHaveLength(1000);
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});
