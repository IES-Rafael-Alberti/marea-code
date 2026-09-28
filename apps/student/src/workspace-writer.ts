import { createHash } from "node:crypto";

import { Sha256DigestSchema, type Sha256Digest } from "@marea/protocol";
import { WorkspaceError, type WorkspaceBackend } from "@marea/workspace-backend";

import type { GuardedWorkspaceWriter, WorkspaceWrite } from "./contracts.js";
import type { EffectLedger, EffectLedgerRecord } from "./effect-ledger.boundary.js";
import { SerialOperationQueue } from "./serial-operation-queue.js";

export interface CrashSafeWorkspaceWriterOptions {
  readonly ledger: EffectLedger;
  readonly workspace: WorkspaceBackend;
}

export class WorkspaceEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceEffectError";
  }
}

function digest(content: string): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${createHash("sha256").update(content).digest("hex")}`);
}

function resultFor(record: EffectLedgerRecord): WorkspaceWrite {
  return { digest: record.contentDigest, operation: record.operation, path: record.path };
}

function backendPath(relativePath: string): string {
  return `/${relativePath}`;
}

async function readDigest(workspace: WorkspaceBackend, path: string): Promise<Sha256Digest | null> {
  try {
    return digest(await workspace.readText(backendPath(path)));
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "not-found") return null;
    throw error;
  }
}

function assertSameEffect(
  record: EffectLedgerRecord,
  path: string,
  contentDigest: Sha256Digest,
): void {
  if (record.path !== path || record.contentDigest !== contentDigest) {
    throw new WorkspaceEffectError("An effect identifier cannot be reused for another write.");
  }
}

class CrashSafeWorkspaceWriter implements GuardedWorkspaceWriter {
  private readonly mutations = new SerialOperationQueue();

  constructor(private readonly options: CrashSafeWorkspaceWriterOptions) {}

  writeApproved(
    effectId: string,
    path: string,
    content: string,
    expectedDigest?: Sha256Digest,
  ): Promise<WorkspaceWrite> {
    return this.mutations.run(() => this.apply(effectId, path, content, expectedDigest));
  }

  private async apply(
    effectId: string,
    path: string,
    content: string,
    expectedDigest?: Sha256Digest,
  ): Promise<WorkspaceWrite> {
    const contentDigest = digest(content);
    const stored = await this.options.ledger.find(effectId);
    if (stored !== null) {
      assertSameEffect(stored, path, contentDigest);
      if (stored.phase === "completed") return resultFor(stored);
      return this.recover(stored, content);
    }
    const beforeDigest = await readDigest(this.options.workspace, path);
    if (expectedDigest !== undefined && beforeDigest !== expectedDigest)
      throw new WorkspaceEffectError("The file changed after review.");
    const prepared: EffectLedgerRecord = {
      beforeDigest,
      contentDigest,
      effectId,
      operation: beforeDigest === null ? "created" : "updated",
      path,
      phase: "prepared",
    };
    await this.options.ledger.put(prepared);
    return this.recover(prepared, content);
  }

  private async recover(record: EffectLedgerRecord, content: string): Promise<WorkspaceWrite> {
    const currentDigest = await readDigest(this.options.workspace, record.path);
    if (currentDigest !== record.contentDigest) {
      if (currentDigest !== record.beforeDigest) {
        throw new WorkspaceEffectError(
          "The workspace changed while an approved write was pending.",
        );
      }
      await this.options.workspace.writeText(backendPath(record.path), content, {
        createParents: true,
      });
      if ((await readDigest(this.options.workspace, record.path)) !== record.contentDigest) {
        throw new WorkspaceEffectError("The approved workspace write could not be verified.");
      }
    }
    const completed: EffectLedgerRecord = { ...record, phase: "completed" };
    await this.options.ledger.put(completed);
    return resultFor(completed);
  }
}

export function createCrashSafeWorkspaceWriter(
  options: CrashSafeWorkspaceWriterOptions,
): GuardedWorkspaceWriter {
  return new CrashSafeWorkspaceWriter(options);
}
