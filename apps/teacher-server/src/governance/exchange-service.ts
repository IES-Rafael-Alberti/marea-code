import { createHash } from "node:crypto";
import {
  ClassExchangeSchema,
  AgentModeSchema,
  Sha256DigestSchema,
  TeachingSettingsSchema,
  UtcTimestampSchema,
  MAX_IMPORT_PREVIEW_SECONDS,
} from "@marea/protocol";
import type * as P from "@marea/protocol";
import type { GovernanceClassScope, GovernanceRepository } from "./contracts.js";
import type {
  GovernanceAuthority,
  GovernanceCommitContext,
  GovernanceIdGenerator,
} from "./authority.js";
import type { Clock } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { TeachingOperatorConfiguration } from "../teaching/configuration/dashboard-contracts.js";
import { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";
import { parseOperatorDocument } from "../platform/operator/operator-configuration-parser.js";
import type { SkillSource } from "../teaching/skills/skill-source.js";
import { materializeTeachingSkills } from "../teaching/skills/materialize-skills.js";
import { materializeConfiguration } from "../teaching/configuration/materialize-configuration.js";
import { classExchangeDigest } from "./class-exchange-digest.js";

export interface GovernanceExchangeSources {
  withSource<T>(
    scope: GovernanceClassScope,
    operation: (source: SkillSource, assertCurrent: () => undefined) => Promise<T>,
  ): Promise<T>;
}
export interface GovernanceExchangeDependencies {
  readonly repository: GovernanceRepository;
  readonly clock: Clock;
  readonly ids: GovernanceIdGenerator;
  readonly operator: TeachingOperatorConfiguration;
  readonly sources: GovernanceExchangeSources;
}

function conflict(): never {
  throw new TeacherDomainError("request.conflict");
}

export class GovernanceExchangeService {
  constructor(private readonly dependencies: GovernanceExchangeDependencies) {}

  exportClass(
    authority: GovernanceAuthority,
    request: P.GovernanceExportClassRequest,
  ): P.ClassExchange {
    const current = this.dependencies.repository.loadClassForExchange({
      context: this.context(authority, request.requestId),
      ...request,
    });
    if (current.settings === null || current.teachingVersion !== request.expectedTeachingVersion)
      conflict();
    return ClassExchangeSchema.parse({
      format: "marea-class-exchange:1",
      source: { displayName: current.classroom.displayName },
      agentMode: current.settings.agentMode,
      classInstructions: current.settings.classInstructions,
      selection: current.settings.selection,
    });
  }

  async preview(authority: GovernanceAuthority, request: P.GovernancePreviewClassImportRequest) {
    const context = this.context(authority, request.requestId);
    const scope = { context, centerId: request.centerId, classId: request.classId };
    const current = this.dependencies.repository.loadClassForExchange(scope);
    if (current.teachingVersion !== request.expectedTeachingVersion) conflict();
    const settings = this.settings(request.package, current.settings);
    const policy = this.capturePolicy(request.classId);
    const previewId = this.dependencies.ids.createId("preview");
    return this.dependencies.sources.withSource(scope, async (source, assertSourceCurrent) => {
      await this.materialize(
        request.classId,
        request.expectedTeachingVersion,
        settings,
        policy.policy,
        source,
        context.generatedVersion,
      );
      const commit = this.context(authority, request.requestId);
      const maximum = Date.parse(commit.now) + MAX_IMPORT_PREVIEW_SECONDS * 1000;
      const deadline =
        authority.kind === "administrator"
          ? Math.min(maximum, Date.parse(authority.session.expiresAt))
          : maximum;
      const expiresAt = UtcTimestampSchema.parse(new Date(deadline).toISOString());
      return this.dependencies.repository.commitClassImportPreview({
        context: commit,
        centerId: request.centerId,
        classId: request.classId,
        expectedTeachingVersion: request.expectedTeachingVersion,
        expectedClassVersion: current.classroom.version,
        operatorFingerprint: policy.fingerprint,
        packageDigest: classExchangeDigest(request.package),
        package: request.package,
        settings,
        previewId,
        expiresAt,
        assertPublicationCurrent: () => {
          assertSourceCurrent();
          if (this.capturePolicy(request.classId).fingerprint !== policy.fingerprint) conflict();
          return undefined;
        },
      });
    });
  }

  async confirm(authority: GovernanceAuthority, request: P.GovernanceConfirmClassImportRequest) {
    const context = this.context(authority, request.requestId);
    const scope = { context, centerId: request.centerId, classId: request.classId };
    const preview = this.dependencies.repository.loadPendingClassImport(scope, request.previewId);
    const policy = this.capturePolicy(request.classId);
    if (policy.fingerprint !== preview.operatorFingerprint) conflict();
    const current = this.dependencies.repository.loadClassForExchange(scope);
    const settings = this.settings(preview.package, current.settings);
    if (JSON.stringify(settings) !== JSON.stringify(preview.settings)) conflict();
    return this.dependencies.sources.withSource(scope, async (source, assertSourceCurrent) => {
      const configuration = await this.materialize(
        request.classId,
        preview.expectedTeachingVersion,
        settings,
        policy.policy,
        source,
        context.generatedVersion,
      );
      return this.dependencies.repository.commitClassImportConfirmation({
        context: { ...context, now: UtcTimestampSchema.parse(this.dependencies.clock.now()) },
        preview,
        configuration,
        assertPublicationCurrent: () => {
          assertSourceCurrent();
          if (this.capturePolicy(request.classId).fingerprint !== policy.fingerprint) conflict();
          return undefined;
        },
      });
    });
  }

  cancel(authority: GovernanceAuthority, request: P.GovernanceCancelClassImportRequest) {
    return this.dependencies.repository.commitClassImportCancellation({
      ...request,
      context: this.context(authority, request.requestId),
    });
  }

  private context(authority: GovernanceAuthority, requestId: P.RequestId): GovernanceCommitContext {
    return {
      authority,
      requestId,
      now: UtcTimestampSchema.parse(this.dependencies.clock.now()),
      generatedVersion: this.dependencies.ids.createId("revision"),
    };
  }

  private settings(
    payload: P.ClassExchange,
    destination: P.TeachingSettings | null,
  ): P.TeachingSettings {
    const automaticEvaluation = destination?.automaticEvaluation ?? false;
    if (
      destination?.automaticEvaluation === true &&
      JSON.stringify(destination.selection.evaluation) !==
        JSON.stringify(payload.selection.evaluation)
    )
      conflict();
    return TeachingSettingsSchema.parse({
      agentMode: payload.agentMode,
      classInstructions: payload.classInstructions,
      selection: payload.selection,
      automaticEvaluation,
    });
  }

  private capturePolicy(classId: string) {
    const declared = this.dependencies.operator.forClass(classId);
    if (declared === null) throw new TeachingConfigurationError("operator-unconfigured");
    const policy = parseOperatorDocument({
      version: 1,
      classes: [{ classId, policy: declared }],
    }).forClass(classId);
    if (policy === null) throw new TeachingConfigurationError("operator-unconfigured");
    const fingerprint = Sha256DigestSchema.parse(
      `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`,
    );
    return { policy, fingerprint };
  }

  private async materialize(
    classId: P.Center["centerId"],
    expectedVersion: P.Center["version"] | null,
    settings: P.TeachingSettings,
    policy: NonNullable<ReturnType<TeachingOperatorConfiguration["forClass"]>>,
    source: SkillSource,
    version: string,
  ) {
    // Even inactive/free-mode references must remain exact and destination-accessible.
    await materializeTeachingSkills(source, {
      ...settings.selection,
      agentMode: AgentModeSchema.enum.tutoring,
    });
    return materializeConfiguration(
      { ...settings, classId, expectedVersion, teacherToolPolicy: policy.teacherToolPolicy },
      policy.route,
      source,
      version,
    );
  }
}
