import type { DashboardLocale } from "../../messages.js";
import type { ReviewedEvidenceController } from "./controller.js";
import { reviewedEvidenceMessages } from "./messages.js";
import "../usage-health.css";

export function ReviewedEvidenceView({
  locale,
  controller,
  openSession,
}: {
  readonly locale: DashboardLocale;
  readonly controller: ReviewedEvidenceController;
  readonly openSession: (runId: string) => Promise<boolean>;
}) {
  const m = reviewedEvidenceMessages(locale);
  const page = controller.response;
  return (
    <section className="class-projection" aria-label={m.title}>
      <h2>{m.title}</h2>
      <p>{m.meaning}</p>
      {controller.status !== "ready" && <div role="status">{m[controller.status]}</div>}
      <nav aria-label={m.title}>
        <button
          onClick={() => {
            void controller.students();
          }}
        >
          {m.students}
        </button>
        {page !== null && page.kind !== "students" && (
          <button
            onClick={() => {
              void controller.criteria(page.query.studentId);
            }}
          >
            {m.criteria}
          </button>
        )}
        <button
          onClick={() => {
            void controller.refresh();
          }}
        >
          {m.refresh}
        </button>
      </nav>
      {page !== null && page.entries.length === 0 && <p>{m.none}</p>}
      {page?.kind === "students" && (
        <ul>
          {page.entries.map((student) => (
            <li key={student.studentId}>
              <button
                onClick={() => {
                  void controller.criteria(student.studentId);
                }}
              >
                {`${student.displayName} · ${student.studentId}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {page?.kind === "criteria" && (
        <ul>
          {page.entries.map((criterion) => (
            <li key={JSON.stringify([criterion.skillId, criterion.digest, criterion.code])}>
              <p>
                {criterion.skillId} / {criterion.code}: {criterion.statement}
              </p>
              <p>
                {m.version}: <code>{criterion.digest}</code>
              </p>
              <button
                onClick={() => {
                  void controller.history(page.query.studentId, {
                    skillId: criterion.skillId,
                    digest: criterion.digest,
                    code: criterion.code,
                  });
                }}
              >
                {m.history}
              </button>
            </li>
          ))}
        </ul>
      )}
      {page?.kind === "history" && (
        <>
          {
            <p>
              {page.query.studentId} · {page.query.criterion.skillId} / {page.query.criterion.code}
              <br />
              {m.version}: <code>{page.query.criterion.digest}</code>
            </p>
          }
          <ol>
            {page.entries.map((entry) => (
              <li key={entry.evaluationId}>
                <time dateTime={entry.approvedAt}>
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  }).format(new Date(entry.approvedAt))}
                </time>
                <p>
                  {m.generation}: {entry.generation} · {entry.runId}
                </p>
                {entry.hasLaterApproval && <p>{m.older}</p>}
                <p>
                  {m[entry.result]} · {m.confidence}: {m[entry.confidence]}
                </p>
                <p>{entry.evidence}</p>
                <button
                  onClick={() => {
                    void controller.open(entry.runId, openSession);
                  }}
                >
                  {m.open}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {controller.navigationBlocked && <p role="alert">{m.blocked}</p>}
      {page?.next != null && (
        <button
          onClick={() => {
            void controller.more();
          }}
        >
          {m.more}
        </button>
      )}
    </section>
  );
}
