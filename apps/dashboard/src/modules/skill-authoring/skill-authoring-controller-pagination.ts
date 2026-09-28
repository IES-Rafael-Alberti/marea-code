import type { TeachingCatalogEntry, TeachingClassSummary } from "@marea/protocol";

import type { SkillAuthoringClient } from "./skill-authoring-contracts.js";
import { compareBinary } from "./skill-authoring-state.boundary.js";

export async function readSkillAuthoringClasses(
  client: SkillAuthoringClient,
  signal: AbortSignal,
): Promise<readonly TeachingClassSummary[]> {
  const byId = new Map<string, TeachingClassSummary>();
  let cursor: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const page = await client.classes(cursor, signal);
    for (const entry of page.classes) {
      if (!byId.has(entry.classId)) byId.set(entry.classId, entry);
    }
    const next = page.nextAfterClassId;
    if (next === null) return [...byId.values()];
    if (cursor !== null && compareBinary(next, cursor) <= 0) {
      throw new Error();
    }
    cursor = next;
  }
}

export async function readSkillAuthoringCatalog(
  client: SkillAuthoringClient,
  classId: string,
  signal: AbortSignal,
): Promise<readonly TeachingCatalogEntry[]> {
  const catalog: TeachingCatalogEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const page = await client.catalog(classId, cursor, signal);
    for (const entry of page.skills) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        catalog.push(entry);
      }
    }
    const next = page.nextAfterSkillId;
    if (next === null) return catalog;
    if (cursor !== null && compareBinary(next, cursor) <= 0) {
      throw new Error();
    }
    cursor = next;
  }
}
