import { RequestIdSchema, RevisionIdSchema, Sha256DigestSchema } from "@marea/protocol";
import { z } from "zod";

import { command, type CommandSpec, type Summary } from "../operator-cli/commands.js";
import { MAX_ARTIFACT_BYTES } from "../operations/canonical-encoder.js";
import type { RecoveryInspection } from "../operations/contracts.js";
import {
  AbsolutePathSchema,
  IndexGenerationSchema,
  PreviewArtifactSchema,
  TargetRefSchema,
} from "../operations/schemas.js";
import { transferContinuationSchema } from "./transfer-schemas.js";
import type { OperationsApplication } from "./operations-application.js";

type Spec = CommandSpec<OperationsApplication>;

function inputs() {
  const operation = {
    operationId: RevisionIdSchema,
    expectedIndexGeneration: IndexGenerationSchema,
  };
  return {
    preview: z
      .object({
        requestId: RequestIdSchema,
        previewId: RevisionIdSchema,
        policyRevision: RevisionIdSchema,
        targets: z.array(TargetRefSchema).min(1).max(1_000),
      })
      .strict(),
    inspect: z.object({ operationId: RevisionIdSchema.optional() }).strict(),
    continue: z.object({ ...operation, artifactDigest: Sha256DigestSchema }).strict(),
    markFailed: z.object(operation).strict(),
    backup: z
      .object({
        name: z
          .string()
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
      })
      .strict(),
    reconcile: z
      .object({ bundlePath: AbsolutePathSchema, restoredDatabasePath: AbsolutePathSchema })
      .strict(),
    restore: z
      .object({ bundlePath: AbsolutePathSchema, destinationRoot: AbsolutePathSchema })
      .strict(),
    transferStart: z
      .object({ handoffId: RevisionIdSchema, destinationInstallation: AbsolutePathSchema })
      .strict(),
    transferAbort: z.object({ handoffId: RevisionIdSchema }).strict(),
    transferContinue: transferContinuationSchema(),
  };
}

function inspection(value: RecoveryInspection): { readonly summary: Summary } {
  return {
    summary: {
      state: value.state,
      operationId: value.operationId,
      checkpointState: value.checkpoint?.state ?? null,
      reasonCode: value.reasonCode,
    },
  };
}

/** Private OPERATIONS operations; each runs offline under the installation lock the CLI holds. */
export function operationsCommands(): Readonly<Record<string, Spec>> {
  const input = inputs();
  return Object.freeze({
    "server-settings initialize": command<OperationsApplication>(
      ["userId", "name"],
      async (app, request) => {
        const parsed = z
          .object({ userId: RevisionIdSchema, name: input.backup.shape.name })
          .strict()
          .parse(request.payload);
        return { summary: await app.initializeServerSettings(parsed.userId, parsed.name) };
      },
    ),
    "installation initialize": command<OperationsApplication>(
      [],
      (app) => Promise.resolve({ summary: app.initialize() }),
      { flags: [] },
    ),
    "installation upgrade-profiles": command<OperationsApplication>(
      ["name"],
      async (app, request) => ({
        summary: await app.upgradeProfiles(input.backup.parse(request.payload).name),
      }),
    ),
    "deletion activate": command<OperationsApplication>(
      [],
      (app) => Promise.resolve({ summary: app.activate() }),
      { flags: [] },
    ),
    "deletion preview": command<OperationsApplication>(
      Object.keys(input.preview.shape),
      async (app, request) => {
        const artifact = await app.preview(input.preview.parse(request.payload));
        return {
          summary: {
            previewId: artifact.previewId,
            artifactDigest: artifact.artifactDigest,
            blockers: artifact.blockers.length,
            rows: artifact.counts.rows,
            backups: artifact.counts.backups,
          },
          artifact: { value: artifact, maxBytes: MAX_ARTIFACT_BYTES },
        };
      },
      { flags: ["input", "output"] },
    ),
    "deletion confirm": command<OperationsApplication>(
      Object.keys(PreviewArtifactSchema.shape),
      async (app, request) => ({
        summary: await app.confirm(PreviewArtifactSchema.parse(request.payload)),
      }),
      { inputBytes: MAX_ARTIFACT_BYTES },
    ),
    "recovery inspect": command<OperationsApplication>(["operationId"], async (app, request) =>
      inspection(await app.inspect(input.inspect.parse(request.payload).operationId)),
    ),
    "recovery continue": command<OperationsApplication>(
      Object.keys(input.continue.shape),
      async (app, request) =>
        inspection(await app.continueExact(input.continue.parse(request.payload))),
    ),
    "recovery mark-failed": command<OperationsApplication>(
      Object.keys(input.markFailed.shape),
      async (app, request) =>
        inspection(await app.markFailed(input.markFailed.parse(request.payload))),
    ),
    "backup create": command<OperationsApplication>(["name"], async (app, request) => ({
      summary: await app.createBackup(input.backup.parse(request.payload).name),
    })),
    "backup restore": command<OperationsApplication>(
      Object.keys(input.restore.shape),
      async (app, request) => ({
        summary: { ...(await app.restore(input.restore.parse(request.payload))) },
      }),
    ),
    "transfer start": command<OperationsApplication>(
      Object.keys(input.transferStart.shape),
      async (app, request) => ({
        summary: { ...(await app.transferStart(input.transferStart.parse(request.payload))) },
      }),
    ),
    "transfer abort": command<OperationsApplication>(
      Object.keys(input.transferAbort.shape),
      async (app, request) => ({
        summary: { ...(await app.transferAbort(input.transferAbort.parse(request.payload))) },
      }),
    ),
    "transfer inspect": command<OperationsApplication>(
      [],
      async (app) => ({ summary: { transfer: await app.transferInspect() } }),
      { flags: [] },
    ),
    "recovery transfer-continue": command<OperationsApplication>(
      Object.keys(input.transferContinue.shape),
      async (app, request) => ({
        summary: { ...(await app.transferContinue(input.transferContinue.parse(request.payload))) },
      }),
    ),
    "backup reconcile": command<OperationsApplication>(
      Object.keys(input.reconcile.shape),
      async (app, request) => {
        const result = await app.reconcile(input.reconcile.parse(request.payload));
        return {
          summary: {
            state: result.state,
            reasonCode: result.reasonCode,
            currentIndexGeneration: result.currentIndexGeneration,
            checked: result.checked,
            tombstoned: result.tombstoned.length,
          },
        };
      },
    ),
  });
}
