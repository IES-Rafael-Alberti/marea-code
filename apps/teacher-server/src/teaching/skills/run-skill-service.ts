import {
  CURRENT_PROTOCOL_VERSION,
  RunSkillResponseSchema,
  type RunSkillRequest,
  type RunSkillResponse,
  type StudentRunSnapshot,
} from "@marea/protocol";

import { TeacherDomainError } from "../../identity/errors.js";
import type { AuthorizedRunLease } from "../../sessions/contracts.js";
import type { TeachingSnapshotContent } from "../configuration/configuration-schema.js";

export interface StoredRunTeachingSnapshot {
  readonly snapshot: StudentRunSnapshot;
  readonly teaching: TeachingSnapshotContent;
}

export interface RunSkillRepository {
  loadRunTeaching(runId: string, snapshotId: string): StoredRunTeachingSnapshot | null;
}

export class RunSkillService {
  readonly #repository: RunSkillRepository;
  readonly #leases: { authorizeLease(token: string): AuthorizedRunLease };

  constructor(
    repository: RunSkillRepository,
    leases: { authorizeLease(token: string): AuthorizedRunLease },
  ) {
    this.#repository = repository;
    this.#leases = leases;
  }

  read(leaseToken: string, request: RunSkillRequest): RunSkillResponse {
    const lease = this.#leases.authorizeLease(leaseToken);
    if (lease.runId !== request.runId) throw new TeacherDomainError("run.unavailable");
    const stored = this.#repository.loadRunTeaching(request.runId, request.snapshotId);
    if (stored?.snapshot.id !== request.snapshotId || stored.snapshot.agentMode === "free") {
      throw new TeacherDomainError("run.unavailable");
    }
    const reference = stored.snapshot.didacticSkills.find(({ id }) => id === request.skillId);
    const bundle = stored.teaching.didacticSkills.find(
      ({ id, digest }) => id === reference?.id && digest === reference.digest,
    );
    if (bundle === undefined) throw new TeacherDomainError("run.unavailable");
    return RunSkillResponseSchema.parse({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      runId: request.runId,
      snapshotId: request.snapshotId,
      skill: bundle,
    });
  }
}
