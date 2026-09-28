import { securePrivatePath } from "@marea/private-filesystem";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { ConversationHistory } from "@marea/student-tui";
import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";

const EntriesSchema = z.array(z.string().max(8192)).max(500);
const CredentialSchema = z.object({ token: z.string().min(1) });

export interface PersistentInputHistory extends ConversationHistory {
  flush(): Promise<void>;
}

/** History belongs to this project/server and credential, never another login. */
export async function openInputHistory(stateDirectory: string): Promise<PersistentInputHistory> {
  const storedCredential = await readPrivateTextFile(join(stateDirectory, "credential.json"));
  if (storedCredential === null)
    throw new Error("Student credentials are required for input history.");
  const credential = CredentialSchema.parse(JSON.parse(storedCredential));
  const account = createHash("sha256").update(credential.token).digest("hex");
  const directory = join(stateDirectory, "input-history");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  securePrivatePath(directory, 0o700);
  const path = join(directory, `${account}.json`);
  const content = await readPrivateTextFile(path);
  let entries = content === null ? [] : EntriesSchema.parse(JSON.parse(content));
  let writing = Promise.resolve();
  let failed = false;
  return {
    get entries() {
      return entries;
    },
    remember(text: string): void {
      entries = EntriesSchema.parse([text, ...entries].slice(0, 500));
      const value = JSON.stringify(entries);
      writing = writing
        .then(() => writePrivateFileAtomically(path, value))
        .catch(() => {
          failed = true;
        });
    },
    async flush(): Promise<void> {
      await writing;
      if (failed) throw new Error("Input history could not be saved.");
    },
  };
}
