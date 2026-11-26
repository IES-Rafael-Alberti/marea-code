import type { PendingStudentTurn, StoredRun, StoredTurn } from "./contracts.js";

/**
 * The turn that continues after a restart: the latest one waiting on a write approval, otherwise
 * the latest started one. Every other started turn is superseded.
 */
export function selectedStartedTurn(run: StoredRun): StoredTurn | undefined {
  const started = run.turns.filter((turn) => turn.state === "started");
  // Stryker disable next-line ArrayDeclaration: a non-approval placeholder never matches any message, as an empty list.
  const approvals = run.pendingApprovals ?? [];
  return (
    started.findLast((turn) =>
      approvals.some((approval) => approval.messageId === turn.messageId),
    ) ?? started.at(-1)
  );
}

export function pendingStoredTurn(run: StoredRun): PendingStudentTurn | null {
  const selected = selectedStartedTurn(run);
  if (selected === undefined) return null;
  const failure = selected.lastFailure === undefined ? {} : { failure: selected.lastFailure };
  if (selected.kind === "startup") {
    return {
      ...failure,
      kind: "startup",
      assistantText: selected.text ?? "",
      messageId: selected.messageId,
      text: "",
    };
  }
  if (selected.studentText === undefined) {
    throw new Error("The pending student turn has no reliable original input.");
  }
  return {
    ...failure,
    assistantText: selected.text ?? "",
    messageId: selected.messageId,
    text: selected.studentText,
  };
}
