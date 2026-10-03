import { AnalysisBudget } from "./budget-view.js";
import type { ReactNode } from "react";
import * as z from "zod";
import { insightsMessages } from "./messages.js";
import { localTime } from "./local-time.js";
import { reportsSchema } from "./schemas.js";
import type { useInsightModel, InsightViewProps } from "./model.js";
import { UnconfiguredNotice } from "./unconfigured.js";
interface Props {
  model: ReturnType<typeof useInsightModel>;
  props: InsightViewProps & { classId: string };
  shared: ReactNode;
}
export function ReportsView({ model, props, shared }: Props) {
  const {
    m,
    client,
    abort,
    setError,
    busy,
    data,
    page,
    setPage,
    selectedReport,
    setSelectedReport,
    report,
    setReport,
    from,
    setFrom,
    to,
    setTo,
    action,
  } = model;
  const list = reportsSchema.safeParse(data);
  const download = async (reportId: string) => {
    try {
      const v = await client(
        props.classId,
        { kind: "download", reportId },
        z.object({ html: z.string() }),
        abort.current.signal,
      );
      const url = URL.createObjectURL(new Blob([v.html], { type: "text/html;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `class-report-${reportId}.html`;
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch {
      setError(true);
    }
  };
  return (
    <>
      {shared}
      <p className="insight-note">{m.reportNote}</p>
      {selectedReport === null ? (
        <>
          <div className="insight-controls">
            <label>
              {m.period}
              <select
                defaultValue="24"
                onChange={(e) => {
                  if (e.currentTarget.value !== "custom") {
                    setTo(localTime(Date.now()));
                    setFrom(localTime(Date.now() - Number(e.currentTarget.value) * 3600000));
                  }
                }}
              >
                {[
                  ["6", m.hours6],
                  ["24", m.hours24],
                  ["72", m.hours72],
                  ["168", m.days7],
                  ["custom", m.custom],
                ].map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {m.from}
              <input
                type="datetime-local"
                value={from}
                onChange={(e) => {
                  setFrom(e.currentTarget.value);
                }}
              />
            </label>
            <label>
              {m.to}
              <input
                type="datetime-local"
                value={to}
                onChange={(e) => {
                  setTo(e.currentTarget.value);
                }}
              />
            </label>
            <button
              disabled={busy || !list.success || !list.data.configured || from >= to}
              onClick={() =>
                void action({
                  kind: "generate",
                  from: new Date(from).toISOString(),
                  to: new Date(to).toISOString(),
                  locale: props.locale,
                })
              }
            >
              {m.generate}
            </button>
          </div>
          {page !== null && (
            <button
              onClick={() => {
                setPage(null);
              }}
            >
              {m.back}
            </button>
          )}
          {list.success &&
            list.data.entries.length === 51 &&
            list.data.entries.slice(-1).map((last) => (
              <button
                key={last.id}
                onClick={() => {
                  setPage(last.id);
                }}
              >
                {m.more}
              </button>
            ))}
          {list.success && !list.data.configured && (
            <UnconfiguredNotice
              text={m.unconfigured}
              action={m.configureConnection}
              configure={props.configure}
            />
          )}
          {list.success &&
            list.data.entries.map((r) => (
              <p key={r.id}>
                <button
                  onClick={() => {
                    setSelectedReport(r.id);
                    setReport(null);
                  }}
                >
                  <time dateTime={r.createdAt}>{reportTime(r.createdAt, props.locale)}</time> ·{" "}
                  {statusLabel(r.state, m)}
                </button>
              </p>
            ))}
        </>
      ) : (
        <>
          <button
            onClick={() => {
              setSelectedReport(null);
              setReport(null);
            }}
          >
            {m.back}
          </button>
          {report === null ? (
            <p>{m.loading}</p>
          ) : (
            <>
              <AnalysisBudget budget={report.budget} locale={props.locale} />
              <p role="status">
                {statusLabel(report.state, m)} · {report.completed}/{report.total}
              </p>
              {["queued", "running"].includes(report.state) && (
                <button onClick={() => void action({ kind: "cancel", reportId: report.id })}>
                  {m.cancel}
                </button>
              )}
              {["failed", "interrupted", "cancelled"].includes(report.state) && (
                <button onClick={() => void action({ kind: "retry", reportId: report.id })}>
                  {m.retry}
                </button>
              )}
              {report.result !== null && (
                <>
                  <button onClick={() => void download(report.id)}>{m.download}</button>
                  {report.result.partial && <p role="status">{m.partial}</p>}
                  <p>{report.result.synthesis.summary}</p>
                  {report.result.synthesis.findings.map((f, i) => (
                    <article key={i}>
                      <h3>{f.title}</h3>
                      <p>
                        {f.mode} · {m.affected}: {f.affected.length}/{f.evaluable.length} (
                        {f.evaluable.length === 0
                          ? 0
                          : Math.round((100 * f.affected.length) / f.evaluable.length)}
                        %)
                      </p>
                      <p>{f.explanation}</p>
                      <p>{f.recommendation}</p>
                    </article>
                  ))}
                  <p>{report.result.synthesis.recommendation}</p>
                  <h3>{m.evidence}</h3>
                  {report.result.evidence.map((e) => (
                    <p key={e.runId}>
                      {report.students.find((s) => s.alias === e.alias)?.displayName ?? e.alias} ·{" "}
                      {m[e.status]}{" "}
                      <button
                        onClick={() =>
                          void props.navigate(e.runId).then((ok) => {
                            if (!ok) setError(true);
                          })
                        }
                      >
                        {m.session}
                      </button>
                    </p>
                  ))}
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
function statusLabel(state: string, m: ReturnType<typeof insightsMessages>): string {
  return Object.hasOwn(m, state) ? m[state as keyof typeof m] : state;
}

/** Server timestamps are ISO dates; anything else is shown unchanged rather than hidden. */
function reportTime(timestamp: string, locale: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
