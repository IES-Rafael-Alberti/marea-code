import { createHash } from "node:crypto";
import type { Clock } from "../identity/contracts.js";
import type { PrivateProviderRoute } from "../sessions/contracts.js";
import { summarizeNotes, summaryRoute, type SummaryInference } from "./notes-summary.js";

/** One criterion's stored notes and the label the tutor prompt shows above them. */
export interface CriterionNotes {
  readonly label: string;
  readonly notes: string;
}
/** Asks the provider catalog for a model's context window; undefined when it is unknown. */
export type ContextWindowLookup = (
  providerId: string,
  model: string,
  signal: AbortSignal,
) => Promise<number | undefined>;
export type Shortening = "summarized" | "trimmed";

/** The notes of every criterion, each under its label; criteria without notes are left out. */
export function renderNotes(entries: readonly CriterionNotes[]): string {
  return entries
    .filter((entry) => entry.notes !== "")
    .map((entry) => `${entry.label}:\n${entry.notes}`)
    .join("\n");
}

/**
 * The newest lines of every criterion that fit in `limit` bytes, dropping the oldest first.
 * A line's day is its `dd/mm/aaaa:` prefix; an undated line belongs to the dated line above it,
 * and later lines of the same day are newer.
 */
export function recentNotes(entries: readonly CriterionNotes[], limit: number): string {
  const lines = entries.flatMap((entry, criterion) => {
    let day = 0;
    return entry.notes.split("\n").map((text, position) => {
      const date = /^(\d{2})\/(\d{2})\/(\d{4}):/u.exec(text);
      // dd/mm/aaaa read as the number aaaammdd.
      if (date !== null) day = Number(date.slice(1).toReversed().join(""));
      return { criterion, position, text, day, label: entry.label };
    });
  });
  const kept = new Set<(typeof lines)[number]>();
  const opened = new Set<number>();
  let size = 0;
  for (const line of lines.toSorted((a, b) => b.day - a.day || b.position - a.position)) {
    // A criterion's label and its newline are paid once, with its first kept line.
    const cost =
      (opened.has(line.criterion) ? 0 : Buffer.byteLength(line.label) + 2) +
      Buffer.byteLength(line.text) +
      1;
    if (size + cost > limit) break;
    size += cost;
    kept.add(line);
    opened.add(line.criterion);
  }
  return renderNotes(
    entries.map((entry, criterion) => ({
      label: entry.label,
      notes: lines
        .filter((line) => line.criterion === criterion && kept.has(line))
        .map((line) => line.text)
        .join("\n"),
    })),
  );
}

/**
 * Keeps a session's notes within a quarter of the tutor model's context window. Sizes are UTF-8
 * bytes, the same conservative token estimate as the provider's context preflight. `prepare`
 * runs before the run opens and may ask the model for a summary; `fit` runs inside the opening
 * transaction, never waits and never fails: without a fitting summary it keeps the newest notes.
 * The stored notes are never changed.
 */
export class SessionNotes {
  /** Mutable so tests can shorten it; well below the student client's 30 s request timeout. */
  deadlineMs = 15_000;
  private readonly windows = new Map<string, { tokens: number; expiresAt: number }>();
  private readonly summaries = new Map<string, string>();
  constructor(
    private readonly inference: SummaryInference,
    private readonly clock: Clock,
    private readonly contextWindow: ContextWindowLookup,
  ) {}
  /** Bytes the notes may take; an unknown model is assumed to have a small 32 768-token window. */
  limit(route: PrivateProviderRoute): number {
    return Math.floor((this.windows.get(windowKey(route))?.tokens ?? 32_768) / 4);
  }
  fit(
    route: PrivateProviderRoute,
    scope: string,
    entries: readonly CriterionNotes[],
  ): { readonly text: string; readonly shortened: Shortening | null } {
    const text = renderNotes(entries);
    const limit = this.limit(route);
    if (Buffer.byteLength(text) <= limit) return { text, shortened: null };
    const summary = this.summaries.get(summaryKey(scope, text));
    return summary !== undefined && Buffer.byteLength(summary) <= limit
      ? { text: summary, shortened: "summarized" }
      : { text: recentNotes(entries, limit), shortened: "trimmed" };
  }
  async prepare(
    route: PrivateProviderRoute,
    scope: string,
    accountId: string,
    entries: readonly CriterionNotes[],
  ): Promise<void> {
    const text = renderNotes(entries);
    const key = summaryKey(scope, text);
    const signal = AbortSignal.timeout(this.deadlineMs);
    try {
      await this.refreshWindow(route, signal);
      if (Buffer.byteLength(text) <= this.limit(route) || this.summaries.has(key)) return;
      const summary = await summarizeNotes(
        this.inference,
        summaryRoute(route, route),
        accountId,
        "session",
        text,
        signal,
      );
      // A bounded cache: the oldest summary makes room for a new one.
      for (const oldest of this.summaries.keys()) {
        if (this.summaries.size < 256) break;
        this.summaries.delete(oldest);
      }
      this.summaries.set(key, summary);
    } catch {
      // The session still starts: `fit` keeps the newest notes instead.
    }
  }
  private async refreshWindow(route: PrivateProviderRoute, signal: AbortSignal): Promise<void> {
    const now = Date.parse(this.clock.now());
    const cached = this.windows.get(windowKey(route));
    if (cached !== undefined && cached.expiresAt > now) return;
    const tokens = await this.contextWindow(route.providerId, route.model, signal).catch(
      () => undefined,
    );
    // Like the provider preflight, a known capacity is trusted for five minutes.
    if (tokens !== undefined)
      this.windows.set(windowKey(route), { tokens, expiresAt: now + 300_000 });
  }
}
const windowKey = (route: PrivateProviderRoute) => `${route.providerId}\n${route.model}`;
const summaryKey = (scope: string, text: string) =>
  createHash("sha256")
    .update(JSON.stringify([scope, text]))
    .digest("hex");
