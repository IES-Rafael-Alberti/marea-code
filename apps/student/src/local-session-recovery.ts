import { isDeepStrictEqual } from "node:util";

import type { OpenRunResponse } from "@marea/protocol";

import type { StoredRun } from "./contracts.js";

function isPristineOpening(run: StoredRun): boolean {
  return (
    run.snapshot === null &&
    run.snapshotId === null &&
    run.nextSequence === 1 &&
    run.outbox.length === 0 &&
    run.eventKeys.length === 0 &&
    run.turns.length === 0 &&
    run.approvals.length === 0 &&
    run.effects.length === 0 &&
    (run.pendingApprovals?.length ?? 0) === 0 &&
    run.pendingDelivery === null
  );
}

function assertPendingDeliveryMatchesOutbox(run: StoredRun): void {
  const delivery = run.pendingDelivery?.events;
  if (delivery === undefined) return;
  if (
    delivery.length === 0 ||
    delivery.some((event, index) => !isDeepStrictEqual(event, run.outbox[index]))
  ) {
    throw new Error("The pending delivery is not an exact prefix of the local event outbox.");
  }
}

export function assertActivationCompatible(run: StoredRun, response: OpenRunResponse): void {
  if (run.runId !== null && run.runId !== response.lease.runId) {
    throw new Error("The open response addressed another run.");
  }
  if (
    (run.snapshotId !== null && run.snapshotId !== response.snapshot.id) ||
    (run.snapshot !== null && !isDeepStrictEqual(run.snapshot, response.snapshot))
  ) {
    throw new Error("The open response changed the run's immutable snapshot.");
  }
  assertPendingDeliveryMatchesOutbox(run);
  if (isPristineOpening(run)) return;
  const pendingSequences = run.outbox.map((event) => event.value.sequence);
  const firstPending = pendingSequences[0] ?? run.nextSequence;
  if (
    pendingSequences.some(
      (sequence, index) => sequence !== firstPending + index || sequence >= run.nextSequence,
    )
  ) {
    throw new Error("The local event outbox is inconsistent with its next sequence.");
  }
  const highestAcknowledgedLocally = firstPending - 1;
  const highestCreatedLocally = run.nextSequence - 1;
  if (
    response.highestDurableSequence < highestAcknowledgedLocally ||
    response.highestDurableSequence > highestCreatedLocally
  ) {
    throw new Error("The open response cannot be reconciled with local durable events.");
  }
}
