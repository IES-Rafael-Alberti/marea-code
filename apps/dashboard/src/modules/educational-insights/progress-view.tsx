import { useState, type ReactNode } from "react";
import type * as z from "zod";
import { CriterionHistory } from "./history-view.js";
import { overviewSchema } from "./schemas.js";
import type { useInsightModel, InsightViewProps } from "./model.js";

type Model = ReturnType<typeof useInsightModel>;
type Student = z.infer<typeof overviewSchema>["students"][number];
type Entry = Student["entries"][number];
interface Props {
  model: Model;
  props: InsightViewProps & { classId: string };
  shared: ReactNode;
}

/** Every student of the page at once, as in Marejada: one disclosure per student. */
export function ProgressView({ model, props, shared }: Props) {
  const { m, busy, data, page, setPage } = model;
  const value = overviewSchema.safeParse(data);
  return (
    <>
      {shared}
      <p className="insight-note">{m.adaptationNote}</p>
      {!value.success ? (
        <p>{m.loading}</p>
      ) : value.data.students.length === 0 ? (
        <p>{m.noStudents}</p>
      ) : (
        value.data.students.map((student, index) => (
          <StudentProgress
            key={student.id}
            student={student}
            open={index === 0}
            model={model}
            props={props}
          />
        ))
      )}
      {value.success && (page !== null || value.data.next !== null) && (
        <div className="progress-pages">
          {page !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPage(null);
              }}
            >
              {m.back}
            </button>
          )}
          {value.data.next !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPage(value.data.next);
              }}
            >
              {m.more}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Criteria grouped by skill, with an adjustment form that belongs to this student only. */
export function StudentProgress({
  student,
  open,
  model,
  props,
}: {
  student: Student;
  open: boolean;
  model: Model;
  props: InsightViewProps & { classId: string };
}) {
  const { m, busy, client, action } = model;
  const [reason, setReason] = useState("");
  const [level, setLevel] = useState(0);
  const blocked = busy || reason.trim() === "";
  const adjust = (keys: string[], target: number) =>
    action({
      kind: "adjust",
      studentId: student.id,
      keys,
      level: target,
      reason,
      expectedRevision: student.revision,
    });
  const skills = new Map<string, Entry[]>();
  for (const entry of student.entries) {
    const entries = skills.get(entry.skillId) ?? [];
    entries.push(entry);
    skills.set(entry.skillId, entries);
  }
  const consolidated = student.entries.filter((entry) => entry.level === 4).length;
  return (
    <details className="progress-student" open={open}>
      <summary>
        <strong>{student.displayName}</strong>
        <span className="progress-summary">
          {student.entries.length === 0
            ? m.noProgress
            : `${String(student.entries.length)} ${m.criteria} · ${String(consolidated)} ${m.consolidatedCount}`}
        </span>
      </summary>
      {student.entries.length > 0 && (
        <div className="insight-controls progress-adjust">
          <strong>{m.adjust}</strong>
          <label>
            {m.reason}
            <input
              maxLength={1000}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value);
              }}
            />
          </label>
          <label>
            {m.level}
            <select
              value={level}
              onChange={(event) => {
                setLevel(Number(event.currentTarget.value));
              }}
            >
              {[0, 1, 2, 3, 4].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <p className="insight-note">{m.oldDefinition}</p>
        </div>
      )}
      {[...skills].map(([skillId, entries]) => (
        <section className="progress-skill" key={skillId}>
          {/* The namespace is in the tooltip; the label keeps Marejada's short skill name. */}
          <h3 title={skillId}>{skillId.slice(skillId.lastIndexOf("/") + 1)}</h3>
          {entries.map((entry) =>
            criterion(
              entry,
              m,
              blocked,
              () => void adjust([entry.key], level),
              <CriterionHistory
                client={client}
                classId={props.classId}
                studentId={student.id}
                criterionKey={entry.key}
                locale={props.locale}
              />,
            ),
          )}
          <button
            type="button"
            disabled={blocked}
            onClick={() => {
              if (window.confirm(m.confirmReset))
                void adjust(
                  entries.map((entry) => entry.key),
                  0,
                );
            }}
          >
            {m.resetSkill}
          </button>
        </section>
      ))}
    </details>
  );
}

/** A plain render helper, not a component, so the student's buttons stay in one tree. */
function criterion(
  entry: Entry,
  m: Model["m"],
  blocked: boolean,
  setLevel: () => void,
  history: ReactNode,
) {
  return (
    <article className="progress-criterion" key={entry.key}>
      <p className="progress-statement">
        <strong>{entry.code}</strong> · {entry.statement}
      </p>
      <p className="progress-level">{entry.level}/4</p>
      <p className="progress-next">
        {entry.level >= 4
          ? m.consolidated
          : `${m.nextLevel} ${String(entry.level + 1)}/4 · ${entry.levels[entry.level] ?? ""}`}
      </p>
      <div className="progress-actions">
        <button type="button" disabled={blocked} onClick={setLevel}>
          {m.setLevel}
        </button>
        {history}
      </div>
    </article>
  );
}
