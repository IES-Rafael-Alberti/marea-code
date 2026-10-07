import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findRepositorySkillRoot(start: string): string {
  let directory = start;
  for (;;) {
    const candidate = join(directory, "content/skills");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Could not locate the repository skill catalog.");
    directory = parent;
  }
}
