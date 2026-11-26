import { useEffect, useRef, useState } from "react";
import type * as z from "zod";
import { MAX_LEARNING_NOTES_CHARACTERS } from "@marea/protocol";
import type { DashboardLocale } from "../../messages.js";
import type { insightsClient } from "./client.js";
import { notesMessages, proposalFailure } from "./notes-messages.js";
import { notesSchema, proposalSchema, savedNotesSchema } from "./schemas.js";

/**
 * Above this many characters the notes deserve a summary. It is the session budget of a model
 * with the server's conservative default window (a quarter of 32 768 tokens, counted as bytes),
 * so one criterion this long may already be shortened when a session starts.
 */
export const LONG_NOTES_CHARACTERS = 8000;

/**
 * The teacher's draft after a save found newer notes: what an approval appended to the text the
 * teacher opened is added below the draft. Any other change is added whole, so no text is lost.
 */
export function mergeNotes(original: string, draft: string, current: string): string {
  const added = current.startsWith(original)
    ? current.slice(original.length).replace(/^\n/u, "")
    : current;
  return added === "" ? draft : draft === "" ? added : `${draft}\n${added}`;
}

type Notice = "conflict" | "error" | "proposed" | { readonly failure: string | null } | null;

/** One criterion's notes: open, edit, propose a summary and save with a revision check. */
export function CriterionNotes(props: {
  readonly client: ReturnType<typeof insightsClient>;
  readonly classId: string;
  readonly studentId: string;
  readonly criterionKey: string;
  readonly locale: DashboardLocale;
  readonly onSaved: () => void;
}) {
  const m = notesMessages(props.locale);
  const [loaded, setLoaded] = useState<z.infer<typeof notesSchema> | null>(null);
  // Stryker disable next-line StringLiteral: the draft is only shown after opening replaces it.
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const controller = useRef(new AbortController());
  useEffect(() => {
    const abort = controller.current;
    return () => {
      abort.abort();
    };
  }, []);
  const request = <T,>(input: object, schema: z.ZodType<T>) =>
    props.client(
      props.classId,
      { ...input, studentId: props.studentId, key: props.criterionKey },
      schema,
      controller.current.signal,
    );
  async function run<T>(work: () => Promise<T>, done: (value: T) => void) {
    setBusy(true);
    setNotice(null);
    try {
      const value = await work();
      if (!controller.current.signal.aborted) done(value);
    } catch {
      if (!controller.current.signal.aborted) setNotice("error");
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  const open = () =>
    run(
      () => request({ kind: "notes" }, notesSchema),
      (value) => {
        setLoaded(value);
        setDraft(value.notes);
      },
    );
  const save = (opened: z.infer<typeof notesSchema>) =>
    run(
      () =>
        request(
          { kind: "save-notes", notes: draft, expectedRevision: opened.revision },
          savedNotesSchema,
        ),
      (value) => {
        if (value.conflict) {
          setDraft(mergeNotes(opened.notes, draft, value.notes));
          setLoaded(value);
          setNotice("conflict");
        } else {
          setLoaded(null);
          props.onSaved();
        }
      },
    );
  const propose = () =>
    run(
      () => request({ kind: "propose-notes" }, proposalSchema),
      (value) => {
        if (value.proposal === null) setNotice({ failure: value.failure });
        else {
          setDraft(value.proposal);
          setNotice("proposed");
        }
      },
    );
  const tooLong = draft.length > MAX_LEARNING_NOTES_CHARACTERS;
  return (
    <section className="progress-notes">
      {loaded === null ? (
        <button type="button" disabled={busy} onClick={() => void open()}>
          {m.notes}
        </button>
      ) : (
        <>
          <label>
            {m.notes}
            <textarea
              value={draft}
              rows={8}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
              }}
            />
          </label>
          <p className="insight-note">{m.notesHelp}</p>
          <p className="progress-notes-count">{m.count(draft.length)}</p>
          {loaded.omitted > 0 && <p role="status">{m.omitted}</p>}
          {draft.length > LONG_NOTES_CHARACTERS && <p role="status">{m.long}</p>}
          {tooLong && <p role="alert">{m.tooLong}</p>}
          <div className="progress-actions">
            <button type="button" disabled={busy} onClick={() => void propose()}>
              {m.propose}
            </button>
            <button type="button" disabled={busy || tooLong} onClick={() => void save(loaded)}>
              {m.save}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setLoaded(null);
                setNotice(null);
              }}
            >
              {m.cancel}
            </button>
          </div>
        </>
      )}
      {notice === "proposed" && <p role="status">{m.proposed}</p>}
      {notice === "conflict" && <p role="alert">{m.conflict}</p>}
      {notice === "error" && <p role="alert">{m.error}</p>}
      {typeof notice === "object" && notice !== null && (
        <p role="alert">{proposalFailure(m, notice.failure)}</p>
      )}
    </section>
  );
}
