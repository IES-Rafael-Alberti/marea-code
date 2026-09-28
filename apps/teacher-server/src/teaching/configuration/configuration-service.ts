import {
  AgentModeSchema,
  ModelAliasSchema,
  RevisionIdSchema,
  TeacherToolPolicySchema,
} from "@marea/protocol";
import * as z from "zod";

import type { AuthenticatedIdentity, Clock, IdGenerator } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { SkillSource } from "../skills/index.js";
import { materializeConfiguration } from "./materialize-configuration.js";
import {
  ClassInstructionsSchema,
  StoredTeachingConfigurationSchema,
  TeachingSelectionSchema,
  type StoredTeachingConfiguration,
} from "./configuration-schema.js";
import type { TeachingConfigurationRepository } from "./contracts.js";

export const SaveClassTeachingSchema = z
  .object({
    classId: RevisionIdSchema,
    expectedVersion: RevisionIdSchema.nullable(),
    agentMode: AgentModeSchema,
    classInstructions: ClassInstructionsSchema,
    selection: TeachingSelectionSchema,
    teacherToolPolicy: TeacherToolPolicySchema,
    automaticEvaluation: z.boolean(),
  })
  .strict()
  .readonly();

export const ConfiguredTeachingRouteSchema = z
  .object({
    version: RevisionIdSchema,
    modelAlias: ModelAliasSchema,
    providerRoute: StoredTeachingConfigurationSchema.unwrap().shape.providerRoute,
  })
  .strict()
  .readonly();

export interface TeachingConfigurationDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly repository: TeachingConfigurationRepository;
  readonly skills: { forTeacherClass(teacherId: string, classId: string): SkillSource };
  readonly routes: { forClass(classId: string): z.infer<typeof ConfiguredTeachingRouteSchema> };
}

export class TeachingConfigurationService {
  readonly #dependencies: TeachingConfigurationDependencies;

  constructor(dependencies: TeachingConfigurationDependencies) {
    this.#dependencies = dependencies;
  }

  load(identity: AuthenticatedIdentity, classId: string): StoredTeachingConfiguration | null {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    return this.#dependencies.repository.loadForTeacher(identity.userId, classId);
  }

  async save(
    identity: AuthenticatedIdentity,
    input: z.infer<typeof SaveClassTeachingSchema>,
  ): Promise<StoredTeachingConfiguration> {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    const request = SaveClassTeachingSchema.parse(input);
    this.#dependencies.repository.requireTeacherClass(identity.userId, request.classId);
    const revision = this.#dependencies.ids.createId("revision");
    const route = ConfiguredTeachingRouteSchema.parse(
      this.#dependencies.routes.forClass(request.classId),
    );
    const source = this.#dependencies.skills.forTeacherClass(identity.userId, request.classId);
    const configuration = await materializeConfiguration(request, route, source, revision);
    return this.#dependencies.repository.saveRevision({
      classId: request.classId,
      teacherId: identity.userId,
      expectedVersion: request.expectedVersion,
      createdAt: this.#dependencies.clock.now(),
      configuration,
    });
  }
}
