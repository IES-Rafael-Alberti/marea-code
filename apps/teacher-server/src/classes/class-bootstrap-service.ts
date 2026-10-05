import {
  ClassBootstrapResponseSchema,
  ClassSelectionRequiredResponseSchema,
  CURRENT_PROTOCOL_VERSION,
  type ClassBootstrapOutcome,
  type ClassBootstrapRequest,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { ClassroomRepository } from "./contracts.js";

export class ClassBootstrapService {
  readonly #repository: ClassroomRepository;

  public constructor(repository: ClassroomRepository) {
    this.#repository = repository;
  }

  public load(
    identity: AuthenticatedIdentity,
    request: ClassBootstrapRequest,
  ): ClassBootstrapOutcome {
    if (identity.role !== "student") throw new TeacherDomainError("auth.invalid");
    if (identity.classId === null) {
      const classes = this.#repository.studentClasses(identity.userId);
      if (classes.length === 0) throw new TeacherDomainError("auth.invalid");
      return ClassSelectionRequiredResponseSchema.parse({
        classes,
        kind: "class-selection-required",
        principal: { displayName: identity.displayName, role: "student" },
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: request.requestId,
      });
    }
    const bootstrap = this.#repository.loadStudentBootstrap(identity);
    if (bootstrap === undefined) {
      throw new TeacherDomainError("auth.invalid");
    }
    return ClassBootstrapResponseSchema.parse({
      activeRun:
        bootstrap.activeRun === null
          ? null
          : {
              projectDisplayName: bootstrap.activeRun.projectDisplayName,
              runId: bootstrap.activeRun.runId,
              state: "active",
            },
      classroom: { displayName: bootstrap.classDisplayName },
      kind: "class-bootstrapped",
      modelAlias: "marea",
      principal: { displayName: identity.displayName, role: "student" },
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: request.requestId,
    });
  }
}
