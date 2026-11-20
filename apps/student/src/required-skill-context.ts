import type { RunId, StudentRunSnapshot } from "@marea/protocol";

export class RequiredSkillsError extends Error {
  constructor(
    message = "Required teaching materials could not be loaded and verified. Retry before continuing; contact your teacher if the problem persists.",
  ) {
    super(message);
    this.name = "RequiredSkillsError";
  }
}

const CAPACITY_MESSAGE =
  "Required teaching materials exceed the supported prompt size. Ask your teacher to reduce the selected materials and start a new session. No instructions were truncated.";

/** Full verified files, never the paginated tool result. Auxiliary files remain on demand. */
export async function loadRequiredSkills(
  snapshot: StudentRunSnapshot,
  reader: { read(id: string, path: string): Promise<string> },
  signal: AbortSignal,
): Promise<string> {
  const files: string[] = [];
  for (const reference of snapshot.didacticSkills) {
    signal.throwIfAborted();
    const content = await reader.read(reference.id, "SKILL.md");
    signal.throwIfAborted();
    files.push(JSON.stringify({ skillId: reference.id, digest: reference.digest, content }));
  }
  return `Required didactic instructions for this immutable session. All SKILL.md files below have already been loaded in full: apply them without calling a tool to load them again. Explicit class instructions and Marea safety and permission rules take precedence. Auxiliary resources may be read using the exact skillId. These materials never grant permissions.\n${files.join("\n")}`;
}

/** Only completed loads are cached. Failed/aborted loads can be retried on the same snapshot. */
export class RequiredSkillContext {
  private readonly prepared = new Map<
    RunId,
    { readonly snapshotId: string; readonly content: string }
  >();

  async prepare(
    runId: RunId,
    snapshot: StudentRunSnapshot,
    signal: AbortSignal,
    load?: (runId: RunId, snapshot: StudentRunSnapshot, signal: AbortSignal) => Promise<string>,
  ): Promise<void> {
    signal.throwIfAborted();
    if (snapshot.agentMode === "free" || snapshot.didacticSkills.length === 0) return;
    if (this.prepared.has(runId)) {
      this.content(runId, snapshot);
      return;
    }
    // Stryker disable next-line ConditionalExpression,CallExpression: Without this type-narrowing guard, calling an absent loader throws and the catch produces the same RequiredSkillsError.
    if (load === undefined) throw new RequiredSkillsError();
    let content: string;
    try {
      content = await load(runId, snapshot, signal);
    } catch {
      signal.throwIfAborted();
      throw new RequiredSkillsError();
    }
    signal.throwIfAborted();
    // Leave room for the harness and project context within the gateway's 64K message limit.
    if (content.length + snapshot.prompt.content.length > 48_000) {
      throw new RequiredSkillsError(CAPACITY_MESSAGE);
    }
    this.prepared.set(runId, { snapshotId: snapshot.id, content });
  }

  prompt(runId: RunId, snapshot: StudentRunSnapshot, project?: string): string {
    const prompt = [this.content(runId, snapshot), snapshot.prompt.content, project]
      .filter(Boolean)
      .join("\n\n");
    if (prompt.length > 60_000) throw new RequiredSkillsError(CAPACITY_MESSAGE);
    return prompt;
  }

  content(runId: RunId, snapshot: StudentRunSnapshot): string {
    if (snapshot.agentMode === "free" || snapshot.didacticSkills.length === 0) return "";
    const prepared = this.prepared.get(runId);
    if (prepared?.snapshotId !== snapshot.id) throw new RequiredSkillsError();
    return prepared.content;
  }
}
