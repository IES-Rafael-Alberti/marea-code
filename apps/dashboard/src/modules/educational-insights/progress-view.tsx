import type { ReactNode } from "react";
import { CriterionHistory } from "./history-view.js";
import { progressSchema } from "./schemas.js";
import type { useInsightModel, InsightViewProps } from "./model.js";
interface Props {
  model: ReturnType<typeof useInsightModel>;
  props: InsightViewProps & { classId: string };
  shared: ReactNode;
}
export function ProgressView({ model, props, shared }: Props) {
  const {
    m,
    client,
    busy,
    data,
    page,
    setPage,
    setData,
    student,
    setStudent,
    students,
    reason,
    setReason,
    level,
    setLevel,
    action,
  } = model;

  const value = progressSchema.safeParse(data);
  return (
    <>
      {shared}
      <p className="insight-note">{m.adaptationNote}</p>
      <div className="insight-controls">
        <label>
          {m.selectStudent}
          <select
            disabled={busy}
            value={student}
            onChange={(e) => {
              setStudent(e.currentTarget.value);
              setData(null);
            }}
          >
            <option value="">{m.selectStudent}</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>
        {page !== null && (
          <button
            disabled={busy}
            onClick={() => {
              setStudent("");
              setPage(null);
              setData(null);
            }}
          >
            {m.back}
          </button>
        )}
        {students.length === 101 &&
          students.slice(-1).map((last) => (
            <button
              key={last.id}
              disabled={busy}
              onClick={() => {
                setPage(last.id);
                setStudent("");
                setData(null);
              }}
            >
              {m.more}
            </button>
          ))}
      </div>
      {value.success && (
        <>
          <div className="insight-controls progress-adjust">
            <label>
              {m.reason}
              <input
                maxLength={1000}
                value={reason}
                onChange={(e) => {
                  setReason(e.currentTarget.value);
                }}
              />
            </label>
            <label>
              {m.level}
              <select
                value={level}
                onChange={(e) => {
                  setLevel(Number(e.currentTarget.value));
                }}
              >
                {[0, 1, 2, 3, 4].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="insight-note">{m.oldDefinition}</p>
          {value.data.entries.length === 0 && <p>{m.noProgress}</p>}
          {value.data.entries.map((entry) => (
            <article key={entry.key} className="progress-criterion">
              <h3>
                {entry.skillId} · {entry.code}
              </h3>
              <p className="progress-statement">{entry.statement}</p>
              <p className="progress-level">
                {m.level}: {entry.level}/4
              </p>
              <ol>
                {entry.levels.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ol>
              <button
                disabled={busy || reason.trim() === ""}
                onClick={() =>
                  void action({
                    kind: "adjust",
                    studentId: student,
                    keys: [entry.key],
                    level,
                    reason,
                    expectedRevision: value.data.revision,
                  })
                }
              >
                {m.setLevel}
              </button>
              <button
                disabled={busy || reason.trim() === ""}
                onClick={() => {
                  if (window.confirm(m.confirmReset))
                    void action({
                      kind: "adjust",
                      studentId: student,
                      keys: value.data.entries
                        .filter((e) => e.skillId === entry.skillId)
                        .map((e) => e.key),
                      level: 0,
                      reason,
                      expectedRevision: value.data.revision,
                    });
                }}
              >
                {m.resetSkill}
              </button>
              <CriterionHistory
                key={`${student}:${entry.key}`}
                client={client}
                classId={props.classId}
                studentId={student}
                criterionKey={entry.key}
                locale={props.locale}
              />
            </article>
          ))}
        </>
      )}
    </>
  );
}
