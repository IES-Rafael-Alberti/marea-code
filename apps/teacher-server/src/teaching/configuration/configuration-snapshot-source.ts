import { StudentRunSnapshotSchema } from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { ClassConfigurationRequiredError, TeacherDomainError } from "../../identity/errors.js";
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
    private readonly prepareCapture?: (
      capture: RunSnapshotCapture,
      identity: AuthenticatedIdentity,
    ) => Promise<void>,
  ) {
    this.#repository = repository;
  }

  /** Hands the capture a new run would get to the slow preparation, before the run opens. */
  async prepare(identity: AuthenticatedIdentity): Promise<void> {
    if (this.prepareCapture === undefined) return;
    await this.prepareCapture(this.base("snapshot:preparing", identity), identity);
  }

  capture(snapshotId: string, identity: AuthenticatedIdentity): RunSnapshotCapture {
    const capture = this.base(snapshotId, identity);
    return this.adapt?.(capture, identity) ?? capture;
  }

  private base(snapshotId: string, identity: AuthenticatedIdentity): RunSnapshotCapture {
    if (identity.role !== "student" || identity.classId === null)
      throw new TeacherDomainError("run.unavailable");
    const configuration = this.#repository.loadForStudent(identity);
    if (configuration === null) throw new ClassConfigurationRequiredError();
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
    return capture;
  }
}
