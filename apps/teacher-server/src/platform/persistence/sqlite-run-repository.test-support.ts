export function activeLeaseRow(runId = "run:1") {
  return {
    provider_route_json: JSON.stringify({ model: "model", providerId: "openrouter" }),
    run_id: runId,
    student_id: "user:alice",
  } as const;
}

export function activeRunProjection(highestDurableSequence = 1) {
  return {
    highest_durable_sequence: highestDurableSequence,
    last_activity_at: "2026-09-03T10:00:00.000Z",
    pending_approval: 0,
  } as const;
}
