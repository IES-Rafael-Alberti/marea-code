import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillMetadata } from "deepagents";
import { describe, expect, it } from "vitest";

function findSkillFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return findSkillFiles(path);
    }
    return entry.isFile() && entry.name === "SKILL.md" ? [path] : [];
  });
}

describe("bundled skill compatibility", () => {
  it("loads every current SKILL.md while ignoring criterios and executable modules", () => {
    const skillRoot = fileURLToPath(new URL("../../../content/skills/", import.meta.url));
    const paths = findSkillFiles(skillRoot).sort();
    const metadata = paths.map((path) => parseSkillMetadata(path, "project"));
    const testingPath = paths.find((path) => path.endsWith("/didactic/testing/SKILL.md"));

    expect(paths).toHaveLength(3);
    expect(metadata.every((entry) => entry !== null)).toBe(true);
    expect(metadata.map((entry) => entry?.name).sort()).toEqual([
      "free-agent-review",
      "session-review",
      "testing",
    ]);
    expect(readFileSync(testingPath ?? "missing", "utf8")).toContain("\ncriterios:\n");
    expect(
      metadata.every(
        (entry) =>
          entry !== null && !Object.hasOwn(entry, "module") && entry.allowedTools === undefined,
      ),
    ).toBe(true);
  });
});
