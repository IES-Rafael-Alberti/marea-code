import type {
  ApproveEvaluationRequest,
  EvaluationDraft,
  EvaluationFailure,
  GenerateEvaluationRequest,
  TeacherEvaluation,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { EvaluationInput } from "./evaluation-input.js";

export interface EvaluationClaim {
  readonly evaluationId: string;
  readonly workerToken: string;
  readonly input: EvaluationInput;
}

export interface QueueEvaluationInput {
  readonly identity: AuthenticatedIdentity;
  readonly request: GenerateEvaluationRequest;
  readonly evaluationId: string;
  readonly now: string;
}

export interface ReviewEvaluationInput {
  readonly identity: AuthenticatedIdentity;
  readonly request: ApproveEvaluationRequest;
  readonly noticeId: string;
  readonly now: string;
}

export interface EvaluationRepository {
  automaticCandidates(): readonly string[];
  queueAutomatic(runId: string, evaluationId: string, now: string): TeacherEvaluation | null;
  latest(identity: AuthenticatedIdentity, runId: string): TeacherEvaluation | null;
  queue(input: QueueEvaluationInput): TeacherEvaluation;
  approve(input: ReviewEvaluationInput): TeacherEvaluation;
  claim(workerToken: string, now: string): EvaluationClaim | null;
  finish(claim: EvaluationClaim, result: EvaluationDraft | EvaluationFailure, now: string): void;
  recoverInterrupted(now: string): void;
}
