import type { SessionState } from "./session-state.js";

export function focusTargets(state: SessionState): readonly string[] {
  const targets: string[] = [];
  for (const entry of state.transcript) {
    switch (entry.kind) {
      case "tool":
        if (entry.row.outcome !== null) targets.push(`tool:${entry.id}`);
        break;
      case "error":
        if (entry.retryOffered) targets.push(`retry:${entry.id}`);
        break;
    }
  }
  targets.push(...pendingTargets(state));
  if (state.pendingId === null && !state.fatal) targets.push("composer");
  return targets;
}

export function defaultFocus(state: SessionState): string {
  const pending = state.transcript.find((entry) => entry.id === state.pendingId);
  if (pending?.kind === "approval")
    return pending.approval.stage === "rejecting" ? "reason" : "approve";
  if (pending?.kind === "questions") return "answer";
  return state.fatal ? "" : "composer";
}

export function nextFocus(targets: readonly string[], current: string, backwards: boolean): string {
  const index = targets.indexOf(current);
  if (index < 0) return (backwards ? targets.at(-1) : targets[0]) ?? "";
  const position = (index + (backwards ? targets.length - 1 : 1)) % targets.length;
  return targets.slice(position, position + 1).join();
}

function pendingTargets(state: SessionState): string[] {
  const entry = state.transcript.find((candidate) => candidate.id === state.pendingId);
  if (entry?.kind === "approval")
    return entry.approval.stage === "rejecting" ? ["reason"] : ["preview", "approve", "reject"];
  if (entry?.kind === "questions")
    return entry.questions.index > 0 ? ["answer", "previous", "next"] : ["answer", "next"];
  return [];
}
