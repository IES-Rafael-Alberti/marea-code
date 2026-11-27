import { resolve, join } from "node:path";

import * as z from "zod";

import { loadSetting, saveSetting } from "./interface-locale.boundary.js";

const ACCEPTED_VERSIONS_KEY = "marea.accepted-version-pairs.v1";
const MAX_REMEMBERED_PAIRS = 100;
const RememberedPairsSchema = z.array(z.string()).readonly();

/** The server and the two software versions the student accepted knowing they differ. */
export interface VersionPair {
  readonly serverUrl: string;
  readonly serverVersion: string;
  readonly clientVersion: string;
}

export interface StudentVersionAcceptanceStore {
  has(pair: VersionPair): Promise<boolean>;
  remember(pair: VersionPair): Promise<void>;
}

function pairKey(pair: VersionPair): string {
  return JSON.stringify([pair.serverUrl, pair.serverVersion, pair.clientVersion]);
}

async function loadPairs(path: string): Promise<readonly string[]> {
  const parsed = RememberedPairsSchema.safeParse(await loadSetting(path, ACCEPTED_VERSIONS_KEY));
  return parsed.success ? parsed.data : [];
}

/** Acceptances live in the private settings file, shared by every project of this student. */
export function createStudentVersionAcceptanceStore(
  stateRoot: string,
): StudentVersionAcceptanceStore {
  const path = join(resolve(stateRoot), "settings.json");
  return Object.freeze({
    async has(pair: VersionPair): Promise<boolean> {
      return (await loadPairs(path)).includes(pairKey(pair));
    },
    async remember(pair: VersionPair): Promise<void> {
      const key = pairKey(pair);
      const others = (await loadPairs(path)).filter((entry) => entry !== key);
      await saveSetting(
        stateRoot,
        ACCEPTED_VERSIONS_KEY,
        [...others, key].slice(-MAX_REMEMBERED_PAIRS),
      );
    },
  });
}
