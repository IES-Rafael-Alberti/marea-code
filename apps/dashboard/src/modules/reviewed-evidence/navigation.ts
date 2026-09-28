import type { SessionsController } from "../sessions/sessions-controller.js";

/** Uses the mounted session host and its dirty-draft decision; never enables a hidden module. */
export async function openEvidenceSession(
  session: {
    readonly state: Pick<SessionsController["state"], "classId" | "connection">;
    readonly hasUnsavedDrafts: boolean;
    select: SessionsController["select"];
  } | null,
  classId: string | null,
  runId: string,
  signal: AbortSignal,
  confirm: () => boolean,
): Promise<boolean> {
  if (signal.aborted || session === null || classId === null || session.state.classId !== classId)
    return false;
  if (session.hasUnsavedDrafts && !confirm()) return false;
  await session.select(runId);
  return completed(session);
  function completed(current: NonNullable<typeof session>) {
    return (
      !signal.aborted && current.state.classId === classId && current.state.connection === "current"
    );
  }
}
