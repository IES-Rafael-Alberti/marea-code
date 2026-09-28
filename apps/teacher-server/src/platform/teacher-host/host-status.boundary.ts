import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import type { HostStatusPort, HostStatusRecord } from "../operations/host/contracts.js";

function statusSchema() {
  return z
    .object({
      status: z.enum(["starting", "ready", "draining", "stopped", "failed"]),
      releaseId: z.string().min(1).nullable(),
      schemaVersion: z.number().int().nonnegative().nullable(),
      reasonCode: z.string().min(1),
      observedAt: z.string().min(1),
    })
    .strict();
}

/** A private JSON status file replaced atomically; unreadable or foreign content reads as absent. */
export function createFileHostStatus(): HostStatusPort {
  return Object.freeze({
    read(input: { readonly statusPath: string }): Promise<HostStatusRecord | null> {
      try {
        return Promise.resolve(
          statusSchema().parse(
            JSON.parse(new TextDecoder().decode(readFileSync(input.statusPath))),
          ),
        );
      } catch {
        return Promise.resolve(null);
      }
    },
    write(input: { readonly statusPath: string; readonly value: HostStatusRecord }): Promise<void> {
      return new Promise((resolve) => {
        const staged = `${input.statusPath}.staged`;
        writeFileSync(staged, JSON.stringify(statusSchema().parse(input.value)), { mode: 0o600 });
        renameSync(staged, input.statusPath);
        resolve();
      });
    },
  });
}
