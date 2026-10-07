import "./export.css";
import { useEffect, useState } from "react";
import type { DashboardLocale } from "../../messages.js";
import { SessionExportQuerySchema, type SessionExportQuery } from "@marea/protocol";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";
import { type SessionExportClient, saveSessionDownload } from "./export-client.boundary.js";
import { exportMessages } from "./export-messages.js";

export function SessionExportPanel({
  client,
  locale,
  classId,
  runId,
}: {
  client: SessionExportClient;
  locale: DashboardLocale;
  classId: string | null;
  runId?: string;
}) {
  const m = exportMessages(locale);
  const [students, setStudents] = useState<Awaited<ReturnType<SessionExportClient["students"]>>>(
    [],
  );
  const [student, setStudent] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [identities, setIdentities] = useState<SessionExportQuery["identities"]>("names");
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error" | "large">("idle");
  useEffect(() => {
    const controller = new AbortController();
    if (runId === undefined)
      void client.students(controller.signal).then(
        (values) => {
          if (!controller.signal.aborted) setStudents(values);
        },
        () => {
          if (!controller.signal.aborted) setStatus("error");
        },
      );
    return () => {
      controller.abort();
    };
  }, [client, runId]);
  useEffect(() => {
    setStudent("");
  }, [classId]);
  const list = [
    ...new Map(
      students.filter((s) => classId === null || s.classId === classId).map((s) => [s.id, s]),
    ).values(),
  ];
  const download = async () => {
    try {
      setStatus("busy");
      const query = SessionExportQuerySchema.parse({
        identities,
        ...(runId === undefined
          ? {
              ...(classId === null ? {} : { classId }),
              ...(student ? { studentId: student } : {}),
              ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
              ...(until ? { until: `${until}T00:00:00.000Z` } : {}),
            }
          : { runId }),
      });
      const blob = await client.download(query, new AbortController().signal);
      saveSessionDownload(blob);
      setStatus("done");
    } catch (error) {
      setStatus(
        error instanceof EvaluationRequestError && error.status === 413 ? "large" : "error",
      );
    }
  };
  return (
    <details className="session-export">
      <summary>{m.title}</summary>
      <p>{m.note}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <fieldset disabled={status === "busy"}>
          {runId === undefined && (
            <>
              <label>
                {m.student}
                <select
                  value={student}
                  onChange={(e) => {
                    setStudent(e.currentTarget.value);
                  }}
                >
                  <option value="">{m.all}</option>
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.from}
                <input
                  type="date"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.currentTarget.value);
                  }}
                />
              </label>
              <label>
                {m.until}
                <input
                  type="date"
                  value={until}
                  min={from}
                  onChange={(e) => {
                    setUntil(e.currentTarget.value);
                  }}
                />
              </label>
            </>
          )}
          <label>
            {m.identities}
            <select
              value={identities}
              onChange={(e) => {
                setIdentities(e.currentTarget.value === "pseudonyms" ? "pseudonyms" : "names");
              }}
            >
              <option value="names">{m.names}</option>
              <option value="pseudonyms">{m.pseudonyms}</option>
            </select>
          </label>
          <button type="submit">{runId === undefined ? m.download : m.single}</button>
        </fieldset>
      </form>
      {status !== "idle" && (
        <p role={status === "error" || status === "large" ? "alert" : "status"}>{m[status]}</p>
      )}
    </details>
  );
}
