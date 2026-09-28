import {
  EvaluationDraftSchema,
  EvaluationResponseSchema,
  RunHistoryResponseSchema,
  SessionHistoryResponseSchema,
  TeacherEvaluationSchema,
  type TeacherEvaluation,
} from "@marea/protocol";
import { vi } from "vitest";

import type { EvaluationClient } from "./evaluation-client.boundary.js";

export const NOW = "2026-09-08T08:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
export const DRAFT = EvaluationDraftSchema.parse({
  studentFeedback: "Try an empty-input test next.",
  teacherNote: "Private teacher note.",
  difficulties: ["No failure-case explanation."],
  criteria: [
    {
      skillId: "marea/testing",
      code: "C1",
      result: "no-evidence",
      confidence: "low",
      evidence: "",
    },
  ],
});
export const METADATA = {
  evaluationId: "evaluation:one",
  runId: "run:one",
  generation: 1,
  snapshotId: "snapshot:one",
  inputDigest: DIGEST,
  evaluator: { id: "marea/evaluation", digest: DIGEST },
  didacticSkills: [{ id: "marea/testing", digest: DIGEST }],
  createdAt: NOW,
  updatedAt: NOW,
};
export const RECORD = TeacherEvaluationSchema.parse({ ...METADATA, state: "draft", draft: DRAFT });

export function evaluationResponse(evaluation: TeacherEvaluation | null = RECORD) {
  return EvaluationResponseSchema.parse({
    kind: "evaluation-response",
    protocolVersion: "0.1",
    requestId: "request:one",
    evaluation,
  });
}

export const SESSIONS = SessionHistoryResponseSchema.parse({
  kind: "session-history-response",
  protocolVersion: "0.1",
  requestId: "request:one",
  nextBeforeRunId: "run:one",
  runs: [
    {
      runId: "run:one",
      studentDisplayName: "Ada",
      classDisplayName: "Programming",
      projectDisplayName: "Boundary tests",
      state: "closed",
      openedAt: NOW,
      closedAt: NOW,
    },
  ],
});

export const HISTORY = RunHistoryResponseSchema.parse({
  kind: "run-history-response",
  protocolVersion: "0.1",
  requestId: "request:one",
  runId: "run:one",
  state: "closed",
  snapshot: {
    id: "snapshot:one",
    agentMode: "free",
    modelAlias: "marea",
    didacticSkills: [],
    prompt: { version: "prompt:one", content: "Help.", digest: DIGEST },
    teacherToolPolicy: { version: "policy:one", restrictions: [] },
  },
  afterSequence: 0,
  throughSequence: 2,
  nextSequence: 1,
  events: [{ eventType: "run-activated", eventId: "event:one", sequence: 1, occurredAt: NOW }],
});

export function evaluationClientFixture() {
  return {
    sessions: vi.fn<EvaluationClient["sessions"]>().mockResolvedValue(SESSIONS),
    history: vi.fn<EvaluationClient["history"]>().mockResolvedValue(HISTORY),
    query: vi.fn<EvaluationClient["query"]>().mockResolvedValue(evaluationResponse()),
    generate: vi.fn<EvaluationClient["generate"]>().mockResolvedValue(evaluationResponse()),
    approve: vi.fn<EvaluationClient["approve"]>().mockResolvedValue(
      evaluationResponse(
        TeacherEvaluationSchema.parse({
          ...RECORD,
          state: "approved",
          noticeId: "event:feedback",
          approvedAt: NOW,
        }),
      ),
    ),
  };
}
