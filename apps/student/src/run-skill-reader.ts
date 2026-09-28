import { ReadOnlyToolInputError } from "@marea/deepagents-adapter";
import {
  CURRENT_PROTOCOL_VERSION,
  RunSkillResponseSchema,
  SkillIdSchema,
  isSkillFilePath,
  type RequestId,
  type RunId,
  type RunSkillResponse,
  type RunToken,
  type StudentRunSnapshot,
} from "@marea/protocol";

import type { StudentServer } from "./contracts.js";

export interface RunSkillReaderOptions {
  readonly runId: RunId;
  readonly snapshot: StudentRunSnapshot;
  readonly server: Pick<StudentServer, "readSkill">;
  readonly nextRequestId: () => RequestId;
  readonly runToken: () => Promise<RunToken>;
}

export class RunSkillReadError extends ReadOnlyToolInputError {
  constructor() {
    super("The requested teaching resource is not available in this run snapshot.");
    this.name = "RunSkillReadError";
  }
}

/** No filesystem paths or evaluator bundles are exposed through this reader. */
export class RunSkillReader {
  readonly #options: RunSkillReaderOptions;

  constructor(options: RunSkillReaderOptions) {
    // Copy the small authority list before any asynchronous lease or HTTP operation.
    this.#options = {
      ...options,
      snapshot: {
        ...options.snapshot,
        didacticSkills: options.snapshot.didacticSkills.map((reference) => ({ ...reference })),
      },
    };
  }

  async read(skillId: string, path: string): Promise<string> {
    const { snapshot } = this.#options;
    const reference = snapshot.didacticSkills.find((candidate) => candidate.id === skillId);
    if (snapshot.agentMode === "free" || reference === undefined || !isSkillFilePath(path)) {
      throw new RunSkillReadError();
    }
    const request = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: this.#options.nextRequestId(),
      runId: this.#options.runId,
      snapshotId: snapshot.id,
      skillId: SkillIdSchema.parse(skillId),
    };
    const result = RunSkillResponseSchema.parse(
      await this.#options.server.readSkill(await this.#options.runToken(), request),
    );
    if (
      result.requestId !== request.requestId ||
      result.runId !== request.runId ||
      result.snapshotId !== request.snapshotId ||
      result.skill.id !== reference.id ||
      result.skill.digest !== reference.digest ||
      (await bundleDigest(result)) !== reference.digest
    ) {
      throw new RunSkillReadError();
    }
    const file = result.skill.files.find((candidate) => candidate.path === path);
    if (file === undefined) throw new RunSkillReadError();
    return file.content;
  }
}

async function bundleDigest(response: RunSkillResponse): Promise<string> {
  // Keep the catalog's ordered path/NUL/content/NUL digest format byte-for-byte.
  const canonical = response.skill.files.map((file) => `${file.path}\0${file.content}\0`).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
}
