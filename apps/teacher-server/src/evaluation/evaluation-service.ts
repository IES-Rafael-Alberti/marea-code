import {
  ApproveEvaluationRequestSchema,
  CURRENT_PROTOCOL_VERSION,
  EvaluationQuerySchema,
  EvaluationResponseSchema,
  GenerateEvaluationRequestSchema,
  type ApproveEvaluationRequest,
  type EvaluationQuery,
  type GenerateEvaluationRequest,
} from "@marea/protocol";

import type { AuthenticatedIdentity, Clock, IdGenerator } from "../identity/contracts.js";
import type { EvaluationRepository } from "./contracts.js";

export class EvaluationService {
  public constructor(
    private readonly options: {
      readonly repository: EvaluationRepository;
      readonly clock: Clock;
      readonly ids: IdGenerator;
    },
  ) {}

  public query(identity: AuthenticatedIdentity, request: EvaluationQuery) {
    const parsed = EvaluationQuerySchema.parse(request);
    return this.response(parsed.requestId, this.options.repository.latest(identity, parsed.runId));
  }

  public generate(identity: AuthenticatedIdentity, request: GenerateEvaluationRequest) {
    const parsed = GenerateEvaluationRequestSchema.parse(request);
    return this.response(
      parsed.requestId,
      this.options.repository.queue({
        identity,
        request: parsed,
        evaluationId: this.options.ids.createId("event"),
        now: this.options.clock.now(),
      }),
    );
  }

  public approve(identity: AuthenticatedIdentity, request: ApproveEvaluationRequest) {
    const parsed = ApproveEvaluationRequestSchema.parse(request);
    return this.response(
      parsed.requestId,
      this.options.repository.approve({
        identity,
        request: parsed,
        noticeId: this.options.ids.createId("event"),
        now: this.options.clock.now(),
      }),
    );
  }

  private response(requestId: string, evaluation: ReturnType<EvaluationRepository["latest"]>) {
    return EvaluationResponseSchema.parse({
      kind: "evaluation-response",
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
      evaluation,
    });
  }
}
