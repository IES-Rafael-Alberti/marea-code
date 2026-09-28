import { join } from "node:path";

import { EffectIdSchema, Sha256DigestSchema, type Sha256Digest } from "@marea/protocol";
import * as z from "zod";

import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";

const MAX_EFFECTS = 4_096;

const EffectLedgerRecordSchema = z
  .object({
    beforeDigest: Sha256DigestSchema.nullable(),
    contentDigest: Sha256DigestSchema,
    effectId: EffectIdSchema,
    operation: z.enum(["created", "updated"]),
    path: z.string().min(1).max(512),
    phase: z.enum(["prepared", "completed"]),
  })
  .strict()
  .readonly();

const EffectLedgerFileSchema = z
  .object({ effects: z.array(EffectLedgerRecordSchema).max(MAX_EFFECTS).readonly() })
  .strict()
  .refine(
    ({ effects }) => new Set(effects.map((effect) => effect.effectId)).size === effects.length,
    "Workspace effect identifiers must be unique.",
  )
  .readonly();

export interface EffectLedgerRecord {
  readonly beforeDigest: Sha256Digest | null;
  readonly contentDigest: Sha256Digest;
  readonly effectId: string;
  readonly operation: "created" | "updated";
  readonly path: string;
  readonly phase: "prepared" | "completed";
}

export interface EffectLedger {
  find(effectId: string): Promise<EffectLedgerRecord | null>;
  put(record: EffectLedgerRecord): Promise<void>;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

class FileEffectLedger implements EffectLedger {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  find(effectId: string): Promise<EffectLedgerRecord | null> {
    return this.afterMutations(async () => {
      const records = await this.load();
      return records.find((record) => record.effectId === effectId) ?? null;
    });
  }

  put(record: EffectLedgerRecord): Promise<void> {
    return this.enqueue(async () => {
      const records = await this.load();
      const existing = records.find((candidate) => candidate.effectId === record.effectId);
      if (existing !== undefined) {
        if (
          existing.path !== record.path ||
          existing.contentDigest !== record.contentDigest ||
          existing.beforeDigest !== record.beforeDigest ||
          existing.operation !== record.operation
        ) {
          throw new Error("An effect identifier cannot be reused for another workspace effect.");
        }
        if (existing.phase === "completed") return;
      }
      const next = [
        ...records.filter((existing) => existing.effectId !== record.effectId),
        EffectLedgerRecordSchema.parse(record),
      ];
      await writePrivateFileAtomically(
        this.path,
        JSON.stringify(EffectLedgerFileSchema.parse({ effects: next })),
      );
    });
  }

  private async load(): Promise<readonly EffectLedgerRecord[]> {
    const content = await readPrivateTextFile(this.path);
    if (content === null) return [];
    return EffectLedgerFileSchema.parse(parseJson(content)).effects;
  }

  private afterMutations<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutationTail.then(operation, operation);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }
}

export function createFileEffectLedger(stateDirectory: string): EffectLedger {
  return new FileEffectLedger(join(stateDirectory, "workspace-effects.json"));
}
