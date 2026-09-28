import {
  ImportPreviewSchema,
  MAX_IMPORT_PREVIEW_SECONDS,
  MAX_PENDING_PREVIEWS_PER_ACCOUNT,
  MAX_PENDING_PREVIEWS_PER_INSTALLATION,
  TeachingSettingsSchema,
} from "@marea/protocol";
import type {
  GovernanceClassScope,
  GovernanceRepository,
  PreparedClassImportPreview,
  PreparedClassImportConfirmation,
} from "../../governance/contracts.js";
import type { Id, GovernanceCommitContext } from "../../governance/authority.js";
import { GovernanceResourceError } from "../../governance/errors.js";
import { StoredTeachingConfigurationSchema } from "../../teaching/configuration/configuration-schema.js";
import { GovernanceStore, governanceConflict } from "./governance-store.js";
import { rowInteger, rowJson, rowNullableText, rowText } from "./row-parser.boundary.js";
import { storedImportPreview } from "./governance-preview-record.js";
import { classExchangeDigest } from "../../governance/class-exchange-digest.js";
import { commitTeachingRevision } from "./teaching-revision-commit.js";

export class GovernanceExchangeRepository implements Pick<
  GovernanceRepository,
  | "loadClassForExchange"
  | "loadPendingClassImport"
  | "commitClassImportPreview"
  | "commitClassImportConfirmation"
  | "commitClassImportCancellation"
> {
  constructor(private readonly store: GovernanceStore) {}

  loadClassForExchange(scope: GovernanceClassScope) {
    const classroom = this.store.requireClass(scope.context, scope.centerId, scope.classId);
    const row = this.store.database.readOne(
      `SELECT revisions.configuration_json FROM marea_current_class_teaching current
        JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id WHERE current.class_id = ?1`,
      [scope.classId],
    );
    if (row === undefined) return { classroom, teachingVersion: null, settings: null };
    const configuration = rowJson(row, "configuration_json", StoredTeachingConfigurationSchema);
    return {
      classroom,
      teachingVersion: configuration.content.configurationVersion,
      settings: TeachingSettingsSchema.parse({
        agentMode: configuration.publicTemplate.agentMode,
        classInstructions: configuration.classInstructions,
        selection: configuration.selection,
        automaticEvaluation: configuration.content.automaticEvaluation,
      }),
    };
  }

  loadPendingClassImport(scope: GovernanceClassScope, previewId: Id) {
    const row = this.previewRow(scope, previewId);
    if (rowText(row, "state") !== "pending" || rowText(row, "expires_at") <= scope.context.now)
      governanceConflict();
    return storedImportPreview(row);
  }

  commitClassImportPreview(input: PreparedClassImportPreview) {
    return this.store.database.transaction(() => {
      const { context, centerId, classId, previewId, expiresAt } = input;
      const state = this.loadClassForExchange(input);
      this.store.requireVersion(state.classroom.version, input.expectedClassVersion);
      this.store.requireVersion(state.teachingVersion, input.expectedTeachingVersion);
      if (classExchangeDigest(input.package) !== input.packageDigest) governanceConflict();
      const duration = Date.parse(expiresAt) - Date.parse(context.now);
      if (duration <= 0 || duration > MAX_IMPORT_PREVIEW_SECONDS * 1000) governanceConflict();
      const authority = context.authority;
      if (
        authority.kind === "administrator" &&
        this.store.database.readOne(
          "SELECT id FROM marea_auth_sessions WHERE id = ?1 AND expires_at >= ?2",
          [authority.session.sessionId, expiresAt],
        ) === undefined
      )
        governanceConflict();
      this.expire(context.now);
      this.requireCapacity(context);
      if (
        this.store.database.readOne("SELECT id FROM marea_class_exchange_previews WHERE id = ?1", [
          previewId,
        ]) !== undefined
      )
        governanceConflict();
      input.assertPublicationCurrent();
      this.store.database.execute(
        `INSERT INTO marea_class_exchange_previews (id, center_id, class_id, authority, user_id, session_id,
          expected_teaching_version, expected_class_version, operator_fingerprint, package_digest, package_json, settings_json,
          created_at, expires_at, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'pending')`,
        [
          previewId,
          centerId,
          classId,
          authority.kind,
          authority.kind === "administrator" ? authority.session.identity.userId : null,
          authority.kind === "administrator" ? authority.session.sessionId : null,
          input.expectedTeachingVersion,
          input.expectedClassVersion,
          input.operatorFingerprint,
          input.packageDigest,
          JSON.stringify(input.package),
          JSON.stringify(input.settings),
          context.now,
          expiresAt,
        ],
      );
      this.store.audit(context, centerId, "class-import-preview", previewId);
      return ImportPreviewSchema.parse({
        previewId,
        centerId,
        classId,
        expiresAt,
        expectedTeachingVersion: input.expectedTeachingVersion,
        packageDigest: input.packageDigest,
        settings: input.settings,
        preservesDestinationEvaluationPolicy: true,
      });
    });
  }

  commitClassImportConfirmation(input: PreparedClassImportConfirmation) {
    return this.store.database.transaction(() => {
      const { context, preview } = input;
      const scope = { context, centerId: preview.centerId, classId: preview.classId };
      const current = this.loadPendingClassImport(scope, preview.previewId);
      if (JSON.stringify(current) !== JSON.stringify(preview)) governanceConflict();
      const state = this.loadClassForExchange(scope);
      this.store.requireVersion(state.classroom.version, preview.expectedClassVersion);
      this.store.requireVersion(state.teachingVersion, preview.expectedTeachingVersion);
      const configuration = StoredTeachingConfigurationSchema.parse(input.configuration);
      this.store.requireVersion(
        configuration.content.configurationVersion,
        context.generatedVersion,
      );
      const settings = TeachingSettingsSchema.parse({
        agentMode: configuration.publicTemplate.agentMode,
        classInstructions: configuration.classInstructions,
        selection: configuration.selection,
        automaticEvaluation: configuration.content.automaticEvaluation,
      });
      if (JSON.stringify(settings) !== JSON.stringify(preview.settings)) governanceConflict();
      input.assertPublicationCurrent();
      const authority = context.authority;
      commitTeachingRevision(this.store.database, {
        classId: preview.classId,
        expectedVersion: preview.expectedTeachingVersion,
        configuration,
        createdAt: context.now,
        author:
          authority.kind === "operator"
            ? { kind: "operator" }
            : { kind: "administrator", userId: authority.session.identity.userId },
      });
      this.store.database.execute(
        "UPDATE marea_class_exchange_previews SET state = 'consumed', package_json = NULL, settings_json = NULL, result_revision_id = ?2 WHERE id = ?1",
        [preview.previewId, context.generatedVersion],
      );
      this.store.audit(context, preview.centerId, "class-import-confirm", preview.classId);
      return Object.freeze({ classId: preview.classId, teachingVersion: context.generatedVersion });
    });
  }

  commitClassImportCancellation(
    input: Parameters<GovernanceRepository["commitClassImportCancellation"]>[0],
  ) {
    return this.store.database.transaction(() => {
      const row = this.previewRow(input, input.previewId);
      const state = rowText(row, "state");
      if (state === "cancelled") return Object.freeze({ previewId: input.previewId });
      if (state !== "pending" || rowText(row, "expires_at") <= input.context.now)
        governanceConflict();
      this.store.database.execute(
        "UPDATE marea_class_exchange_previews SET state = 'cancelled', package_json = NULL, settings_json = NULL WHERE id = ?1",
        [input.previewId],
      );
      this.store.audit(input.context, input.centerId, "class-import-cancel", input.previewId);
      return Object.freeze({ previewId: input.previewId });
    });
  }

  private previewRow(scope: GovernanceClassScope, previewId: Id) {
    this.store.requireClass(scope.context, scope.centerId, scope.classId);
    const row = this.store.database.readOne(
      "SELECT * FROM marea_class_exchange_previews WHERE id = ?1 AND class_id = ?2 AND center_id = ?3",
      [previewId, scope.classId, scope.centerId],
    );
    if (row === undefined) governanceConflict();
    const authority = scope.context.authority;
    if (rowText(row, "authority") !== authority.kind) governanceConflict();
    if (
      authority.kind === "administrator" &&
      (rowNullableText(row, "user_id") !== authority.session.identity.userId ||
        rowNullableText(row, "session_id") !== authority.session.sessionId)
    )
      governanceConflict();
    return row;
  }

  private expire(now: string): void {
    this.store.database.execute(
      "UPDATE marea_class_exchange_previews SET state = 'expired', package_json = NULL, settings_json = NULL WHERE state = 'pending' AND expires_at <= ?1",
      [now],
    );
  }

  private requireCapacity(context: GovernanceCommitContext): void {
    const user =
      context.authority.kind === "administrator" ? context.authority.session.identity.userId : null;
    const row = this.store.database.readOne(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN user_id = ?1 THEN 1 ELSE 0 END), 0) AS account
        FROM marea_class_exchange_previews WHERE state = 'pending'`,
      [user],
    );
    if (
      row === undefined ||
      rowInteger(row, "total") >= MAX_PENDING_PREVIEWS_PER_INSTALLATION ||
      rowInteger(row, "account") >= MAX_PENDING_PREVIEWS_PER_ACCOUNT
    )
      throw new GovernanceResourceError();
  }
}
