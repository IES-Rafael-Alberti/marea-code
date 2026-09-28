import type { PendingStudentTurn, StoredRun } from "./contracts.js";

export function pendingStoredTurn(run: StoredRun | null): PendingStudentTurn | null {
  if (run?.phase !== "active") return null;
  const started = run.turns.filter((turn) => turn.state === "started");
  const approvals = run.pendingApprovals;
  const candidates =
    approvals === undefined
      ? []
      : started.filter((turn) =>
          approvals.some((approval) => approval.messageId === turn.messageId),
        );
  const selected =
    candidates.length === 1 ? candidates[0] : started.length === 1 ? started[0] : undefined;
  if (selected === undefined) {
    if (started.length > 0) throw new Error("The pending student turn is ambiguous.");
    return null;
  }
  if (selected.kind === "startup") {
    return {
      ...(selected.lastFailure === undefined ? {} : { failure: selected.lastFailure }),
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
    ...(selected.lastFailure === undefined ? {} : { failure: selected.lastFailure }),
    assistantText: selected.text ?? "",
    messageId: selected.messageId,
    text: selected.studentText,
  };
}
