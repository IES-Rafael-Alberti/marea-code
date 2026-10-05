import { join } from "node:path";

import { RevisionIdSchema } from "@marea/protocol";
import * as z from "zod";

import type { ClassPreferenceStore } from "./contracts.js";
import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";

const ClassPreferenceFileSchema = z.object({ classId: RevisionIdSchema }).strict().readonly();

/** The class this project folder chose last, kept privately next to its session state. */
export function createFileClassPreferenceStore(stateDirectory: string): ClassPreferenceStore {
  const path = join(stateDirectory, "class.json");
  return Object.freeze({
    async load(): Promise<string | null> {
      const content = await readPrivateTextFile(path);
      return content === null ? null : ClassPreferenceFileSchema.parse(JSON.parse(content)).classId;
    },
    async save(classId: string): Promise<void> {
      await writePrivateFileAtomically(
        path,
        JSON.stringify(ClassPreferenceFileSchema.parse({ classId })),
      );
    },
  });
}
