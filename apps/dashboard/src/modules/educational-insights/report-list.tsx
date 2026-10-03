import type * as z from "zod";
import type { insightsMessages } from "./messages.js";
import type { reportsSchema } from "./schemas.js";

type Messages = ReturnType<typeof insightsMessages>;
type Entry = z.infer<typeof reportsSchema>["entries"][number];

/** Generated reports, newest first: when, which period, and how far each one got. */
export function ReportList({
  entries,
  page,
  setPage,
  select,
  m,
  locale,
}: {
  entries: readonly Entry[];
  page: string | null;
  setPage: (page: string | null) => void;
  select: (id: string) => void;
  m: Messages;
  locale: string;
}) {
  return (
    <section className="report-history">
      <h3>{m.reportHistory}</h3>
      {entries.length === 0 ? (
        <p className="insight-note">{m.noReports}</p>
      ) : (
        <ul className="report-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="report-row"
                data-state={entry.state}
                onClick={() => {
                  select(entry.id);
                }}
              >
                <time className="report-when" dateTime={entry.createdAt}>
                  {reportTime(entry.createdAt, locale)}
                </time>
                <span className="report-period">
                  {m.period}: {period(entry.from, entry.to, locale)}
                </span>
                <span className="report-state">
                  {statusLabel(entry.state, m)}
                  {["queued", "running"].includes(entry.state) &&
                    ` · ${String(entry.completed)}/${String(entry.total)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="report-pages">
        {page !== null && (
          <button
            type="button"
            onClick={() => {
              setPage(null);
            }}
          >
            {m.back}
          </button>
        )}
        {entries.length === 51 &&
          entries.slice(-1).map((last) => (
            <button
              type="button"
              key={last.id}
              onClick={() => {
                setPage(last.id);
              }}
            >
              {m.more}
            </button>
          ))}
      </div>
    </section>
  );
}

export function statusLabel(state: string, m: Messages): string {
  return Object.hasOwn(m, state) ? m[state as keyof Messages] : state;
}

/** Server timestamps are ISO dates; anything else is shown unchanged rather than hidden. */
function reportTime(timestamp: string, locale: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** The analysed range as one localized span; a report without a period shows a dash. */
function period(from: string, to: string, locale: string) {
  const start = new Date(from);
  const end = new Date(to);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).formatRange(start, end);
}
