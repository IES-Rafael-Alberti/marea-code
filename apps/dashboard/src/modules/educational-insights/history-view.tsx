import { useEffect, useRef, useState } from "react";
import type * as z from "zod";
import type { DashboardLocale } from "../../messages.js";
import type { insightsClient } from "./client.js";
import { historySchema } from "./schemas.js";
import { insightsMessages } from "./messages.js";
export function CriterionHistory(props: {
  readonly client: ReturnType<typeof insightsClient>;
  readonly classId: string;
  readonly studentId: string;
  readonly criterionKey: string;
  readonly locale: DashboardLocale;
}) {
  const m = insightsMessages(props.locale);
  const [entries, setEntries] = useState<z.infer<typeof historySchema>["entries"]>([]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [more, setMore] = useState(false);
  const controller = useRef(new AbortController());
  useEffect(() => {
    const abort = controller.current;
    return () => {
      abort.abort();
    };
  }, []);
  async function load(after: number) {
    setBusy(true);
    setError(false);
    try {
      const result = await props.client(
        props.classId,
        { kind: "history", studentId: props.studentId, key: props.criterionKey, after },
        historySchema,
        controller.current.signal,
      );
      if (controller.current.signal.aborted) return;
      setEntries((previous) => (after === 0 ? result.entries : [...previous, ...result.entries]));
      setMore(result.entries.length === 51);
      setLoaded(true);
    } catch {
      if (!controller.current.signal.aborted) setError(true);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section>
      <button disabled={busy} onClick={() => void load(0)}>
        {m.history}
      </button>
      {error && <p role="alert">{m.error}</p>}
      {loaded && (
        <>
          <ol>
            {entries.map((e) => (
              <li key={e.id}>
                {e.createdAt}: {e.previousLevel} → {e.level}. {e.reason} ({e.actor})
              </li>
            ))}
          </ol>
          {more && (
            <button disabled={busy} onClick={() => void load(entries.at(-1)?.id ?? 0)}>
              {m.more}
            </button>
          )}
        </>
      )}
    </section>
  );
}
