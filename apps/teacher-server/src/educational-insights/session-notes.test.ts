import { describe, expect, it, vi } from "vitest";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import type { PrivateProviderRoute } from "../sessions/contracts.js";
import type { SummaryInference } from "./notes-summary.js";
import { InsightsFailure } from "./model-output.boundary.js";
import {
  recentNotes,
  renderNotes,
  SessionNotes,
  type ContextWindowLookup,
} from "./session-notes.js";

const route: PrivateProviderRoute = {
  providerId: "synthetic-provider",
  model: "synthetic-tutor",
  budget: SYNTHETIC_ROUTE_BUDGET,
};
const entries = [
  { label: "skill/C1", notes: "07/09/2026: Old one.\n09/09/2026: Newest C1." },
  { label: "skill/C2", notes: "08/09/2026: Middle C2.\ncontinued" },
];

describe("notes rendering", () => {
  it("labels every criterion with notes and leaves the others out", () => {
    expect(renderNotes([])).toBe("");
    expect(renderNotes([...entries, { label: "skill/C3", notes: "" }])).toBe(
      "skill/C1:\n07/09/2026: Old one.\n09/09/2026: Newest C1.\nskill/C2:\n08/09/2026: Middle C2.\ncontinued",
    );
  });

  it("drops the oldest lines first across criteria; undated lines follow the date above", () => {
    const all = renderNotes(entries);
    expect(recentNotes(entries, Buffer.byteLength(all) + 1)).toBe(all);
    // Newest C1 costs 10 + 23 bytes; C2's label 10, "continued" 10 and its dated line 23.
    expect(recentNotes(entries, 76)).toBe(
      "skill/C1:\n09/09/2026: Newest C1.\nskill/C2:\n08/09/2026: Middle C2.\ncontinued",
    );
    expect(recentNotes(entries, 75)).toBe(
      "skill/C1:\n09/09/2026: Newest C1.\nskill/C2:\ncontinued",
    );
    expect(recentNotes(entries, 33)).toBe("skill/C1:\n09/09/2026: Newest C1.");
    expect(recentNotes(entries, 32)).toBe("");
    // Undated text before any date is the oldest; later lines of one day are the newer ones.
    expect(
      recentNotes([{ label: "L", notes: "undated\n07/09/2026: a\n07/09/2026: b" }], 3 + 16),
    ).toBe("L:\n07/09/2026: b");
    // Only a leading date counts: a date inside the text does not make a line newer.
    const quoted = [
      { label: "A", notes: "01/09/2026: a\nsee 09/09/2026: b" },
      { label: "B", notes: "05/09/2026: c" },
    ];
    expect(recentNotes(quoted, 17)).toBe("B:\n05/09/2026: c");
    expect(recentNotes([{ label: "L", notes: "undated\n07/09/2026: a" }], 24)).toBe(
      "L:\n07/09/2026: a",
    );
  });
});

type Generate = SummaryInference["generate"];
const summaryOf = (summary: string) => vi.fn<Generate>().mockResolvedValue({ summary });

function subject(
  generate = summaryOf("Short summary."),
  contextWindow: ContextWindowLookup = () => Promise.resolve(400),
  now = vi.fn(() => "2026-09-07T12:00:00.000Z"),
) {
  return { notes: new SessionNotes({ generate }, { now }, contextWindow), generate, now };
}

describe("session notes sizing", () => {
  it("assumes a 32 768-token window until the catalog answers, then uses a quarter of it", async () => {
    const { notes } = subject();
    expect(notes.limit(route)).toBe(8192);
    await notes.prepare(route, "scope", "account", []);
    expect(notes.limit(route)).toBe(100);
    expect(notes.limit({ ...route, model: "other" })).toBe(8192);
  });

  it("keeps notes that fit without asking the model", async () => {
    const { notes, generate } = subject();
    await notes.prepare(route, "scope", "account", entries);
    expect(generate).not.toHaveBeenCalled();
    // Exactly the limit still fits: 3 label bytes + 97 note bytes = 100.
    const exact = [{ label: "L", notes: "x".repeat(97) }];
    await notes.prepare(route, "scope", "account", exact);
    expect(generate).not.toHaveBeenCalled();
    expect(notes.fit(route, "scope", exact).shortened).toBeNull();
    expect(notes.fit(route, "scope", [{ label: "L", notes: "x".repeat(98) }]).shortened).toBe(
      "trimmed",
    );
    expect(notes.fit({ ...route, model: "other" }, "scope", entries)).toEqual({
      text: renderNotes(entries),
      shortened: null,
    });
  });

  it("summarizes notes that do not fit with the session's model and its evaluation budget", async () => {
    const long = [{ label: "skill/C1", notes: "x".repeat(200) }];
    const { notes, generate } = subject();
    await notes.prepare(route, "scope", "notes-session:s1:2026-09-07", long);
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]).toEqual([
      {
        providerId: "synthetic-provider",
        model: "synthetic-tutor",
        budget: SYNTHETIC_ROUTE_BUDGET.evaluation,
        inputTokenCeiling: SYNTHETIC_ROUTE_BUDGET.inputTokenCeiling,
      },
      "notes-session:s1:2026-09-07",
      expect.stringContaining("sesión de tutoría de hoy"),
      { notes: renderNotes(long) },
      expect.anything(),
      expect.any(AbortSignal),
    ]);
    expect(notes.fit(route, "scope", long)).toEqual({
      text: "Short summary.",
      shortened: "summarized",
    });
    // The summary belongs to this exact text and student.
    expect(notes.fit(route, "other scope", long).shortened).toBe("trimmed");
    await notes.prepare(route, "scope", "account", long);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("falls back to the newest notes when the summary fails, is missing or still too long", async () => {
    const long = [{ label: "L", notes: `01/09/2026: ${"x".repeat(150)}\n02/09/2026: recent` }];
    const failing = subject(vi.fn<Generate>().mockRejectedValue(new InsightsFailure("budget")));
    await failing.notes.prepare(route, "scope", "account", long);
    expect(failing.notes.fit(route, "scope", long)).toEqual({
      text: "L:\n02/09/2026: recent",
      shortened: "trimmed",
    });
    const verbose = subject(summaryOf("y".repeat(101)));
    await verbose.notes.prepare(route, "scope", "account", long);
    expect(verbose.notes.fit(route, "scope", long).shortened).toBe("trimmed");
    const exact = subject(summaryOf("y".repeat(100)));
    await exact.notes.prepare(route, "scope", "account", long);
    expect(exact.notes.fit(route, "scope", long).shortened).toBe("summarized");
    const unbudgeted = subject();
    await unbudgeted.notes.prepare({ providerId: "p", model: "m" }, "scope", "account", long);
    expect(unbudgeted.generate).not.toHaveBeenCalled();
  });

  it("gives up within its deadline and keeps the default window when the catalog fails", async () => {
    const long = [{ label: "L", notes: "x".repeat(9000) }];
    const generate = vi.fn<Generate>(
      (...[, , , , , signal]) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const { notes } = subject(generate, () => Promise.reject(new Error("offline")));
    notes.deadlineMs = 10;
    await notes.prepare(route, "scope", "account", long);
    expect(notes.limit(route)).toBe(8192);
    expect(notes.fit(route, "scope", long).shortened).toBe("trimmed");
  });

  it("asks the catalog again when it did not know the window", async () => {
    const lookup = vi.fn<ContextWindowLookup>(() => Promise.resolve(undefined));
    const { notes } = subject(undefined, lookup);
    await notes.prepare(route, "scope", "account", []);
    await notes.prepare(route, "scope", "account", []);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(notes.limit(route)).toBe(8192);
  });

  it("trusts a known window for five minutes and keeps at most 256 summaries", async () => {
    const lookup = vi.fn(() => Promise.resolve(400));
    const { notes, generate, now } = subject(undefined, lookup);
    const long = (index: number) => [{ label: "L", notes: `${String(index)}${"x".repeat(200)}` }];
    for (let index = 0; index < 257; index++)
      await notes.prepare(route, "scope", "account", long(index));
    expect(lookup).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(257);
    expect(notes.fit(route, "scope", long(0)).shortened).toBe("trimmed");
    expect(notes.fit(route, "scope", long(1)).shortened).toBe("summarized");
    now.mockReturnValue("2026-09-07T12:04:59.999Z");
    await notes.prepare(route, "scope", "account", []);
    expect(lookup).toHaveBeenCalledOnce();
    now.mockReturnValue("2026-09-07T12:05:00.000Z");
    lookup.mockResolvedValueOnce(800);
    await notes.prepare(route, "scope", "account", []);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(notes.limit(route)).toBe(200);
  });
});
