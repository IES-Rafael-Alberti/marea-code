import type {
  SkillLibraryEntry,
  SkillWorkspaceStudent,
  SkillWorkspaceResponse,
} from "@marea/protocol";
import type { createSkillWorkspaceClient } from "./client.boundary.js";

/** Follow server cursors without losing already rendered data if a later page fails. */
export async function loadSkillWorkspace(
  request: ReturnType<typeof createSkillWorkspaceClient>,
  classId: string,
  signal: AbortSignal,
) {
  const catalog: SkillLibraryEntry[] = [];
  const students: SkillWorkspaceStudent[] = [];
  let after: string | null = null;
  const seen = new Set<string | null>();
  do {
    const page: Extract<SkillWorkspaceResponse, { kind: "library" }> = await request(
      classId,
      { kind: "library", after: after as SkillLibraryEntry["id"] | null, includeCurriculum: true },
      signal,
    );

    catalog.push(...page.skills);
    after = page.next;
    checkCursor(after, seen);
  } while (after !== null);
  seen.clear();
  do {
    const page: Extract<SkillWorkspaceResponse, { kind: "students" }> = await request(
      classId,
      { kind: "students", after },
      signal,
    );

    students.push(...page.students);
    after = page.next;
    checkCursor(after, seen);
  } while (after !== null);
  return { catalog, students };
}
function checkCursor(after: string | null, seen: Set<string | null>) {
  if (seen.has(after)) throw new Error("unavailable");
  seen.add(after);
}
