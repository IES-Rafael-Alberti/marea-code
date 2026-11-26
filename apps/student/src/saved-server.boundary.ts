import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createFailureLog } from "./failure-log.boundary.js";
import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";
import { parseSavedServer, SAVED_SERVER_FILE, serializeSavedServer } from "./saved-server.js";

/** The server this student last signed in to with an explicit --server. */
export interface SavedServerStore {
  load(): Promise<string | undefined>;
  save(url: string): Promise<void>;
}

const PROBLEM_LOG_FILE = "server-problems.jsonl";

export function createSavedServerStore(stateRoot: string): SavedServerStore {
  const root = resolve(stateRoot);
  const path = join(root, SAVED_SERVER_FILE);
  const problems = createFailureLog(join(root, PROBLEM_LOG_FILE), writePrivateFileAtomically);
  /** The student never sees this; it only explains later why the saved server was not used. */
  async function recordProblem(code: string): Promise<void> {
    try {
      await problems.append({ at: new Date().toISOString(), code });
    } catch {
      // A diagnostic that cannot be written must not block the connection.
    }
  }
  return Object.freeze({
    async load(): Promise<string | undefined> {
      let text: string | null;
      try {
        text = await readPrivateTextFile(path);
      } catch {
        await recordProblem("saved-server.unreadable");
        return undefined;
      }
      if (text === null) return undefined;
      const server = parseSavedServer(text);
      if (server === undefined) await recordProblem("saved-server.invalid");
      return server;
    },
    async save(url: string): Promise<void> {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writePrivateFileAtomically(path, serializeSavedServer(url));
    },
  });
}
