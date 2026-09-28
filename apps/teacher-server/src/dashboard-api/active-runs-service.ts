import {
  ActiveRunDashboardResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  type ActiveRunDashboardQuery,
  type ActiveRunDashboardResponse,
} from "@marea/protocol";

import type { Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { DashboardRepository, DashboardQueryContext } from "./contracts.js";

export class ActiveRunsService {
  readonly #clock: Clock;
  readonly #repository: DashboardRepository;

  public constructor(repository: DashboardRepository, clock: Clock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  public query(
    context: DashboardQueryContext,
    query: ActiveRunDashboardQuery,
  ): ActiveRunDashboardResponse {
    if (context.identity.role !== "teacher") {
      throw new TeacherDomainError("dashboard.forbidden");
    }
    const page = this.#repository.listActiveRuns({
      cursor: query.cursor,
      limit: query.limit,
      teacherId: context.identity.userId,
    });
    return ActiveRunDashboardResponseSchema.parse({
      generatedAt: this.#clock.now(),
      kind: "active-runs-response",
      nextCursor: page.nextCursor,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: query.requestId,
      runs: page.runs,
      viewer: { displayName: context.identity.displayName, role: "teacher" },
    });
  }
}
