import { StudentRunSnapshotSchema } from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { RunSnapshotCapture, RunSnapshotSource } from "../../sessions/contracts.js";
import type { TeachingConfigurationRepository } from "./contracts.js";

export class ConfigurationSnapshotSource implements RunSnapshotSource {
  readonly #repository: TeachingConfigurationRepository;

  constructor(
    repository: TeachingConfigurationRepository,
    private readonly adapt?: (
      capture: RunSnapshotCapture,
      identity: AuthenticatedIdentity,
    ) => RunSnapshotCapture,
  ) {
    this.#repository = repository;
  }

  capture(snapshotId: string, identity: AuthenticatedIdentity): RunSnapshotCapture {
    if (identity.role !== "student" || identity.classId === null)
      throw new TeacherDomainError("run.unavailable");
    const configuration = this.#repository.loadForStudent(identity);
    if (configuration === null) throw new TeacherDomainError("run.unavailable");
    const capture = Object.freeze({
      snapshot: StudentRunSnapshotSchema.parse({
        ...configuration.publicTemplate,
        id: snapshotId,
        ...(configuration.content.startup === null
          ? {}
          : {
              startup: {
                version: configuration.content.startup.version,
                digest: configuration.content.startup.digest,
                content: configuration.content.startup.content,
              },
            }),
      }),
      providerRoute: configuration.providerRoute,
      teaching: configuration.content,
    });
    return this.adapt?.(capture, identity) ?? capture;
  }
}
