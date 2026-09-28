import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { MessageIdSchema, type CanonicalRunEvent, type MessageId } from "@marea/protocol";
import type { LocalSession } from "./local-session.js";
import type { IdSource } from "./contracts.js";
import type { ProjectEvidence } from "./project-evidence.js";
import { projectGit, hasErrorCode } from "./git-workspace.boundary.js";
import { readProjectGitContext } from "./project-git.boundary.js";
import { createProjectContext } from "./session-context.js";

type Change = Omit<
  Extract<CanonicalRunEvent, { eventType: "project-change" }>,
  "eventId" | "sequence" | "occurredAt"
>;
const PendingSchema = z
  .object({
    tree: z.string(),
    actor: z.enum(["student", "agent", "unknown"]),
    messageId: MessageIdSchema.optional(),
    patch: z.string(),
    summary: z.string(),
    truncated: z.boolean(),
  })
  .strict();
const StateSchema = z
  .object({
    tree: z.string().regex(/^[a-f0-9]{40,64}$/),
    agentPending: z.boolean(),
    generation: z.number().int().nonnegative(),
    pending: PendingSchema.optional(),
  })
  .strict();

export interface GitEvidenceOptions {
  readonly root: string;
  readonly directory: string;
  readonly localSession: LocalSession;
  readonly ids: IdSource;
}

/** Private index snapshots never stage or commit the student's files. */
export class GitProjectEvidence implements ProjectEvidence {
  constructor(private readonly options: GitEvidenceOptions) {}

  private async location(): Promise<string> {
    const run = (await this.options.localSession.load()).run;
    if (typeof run?.runId !== "string") throw new Error("Project evidence needs an active run.");
    const directory = join(
      this.options.directory,
      "project-evidence",
      encodeURIComponent(run.runId),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async snapshot(directory: string): Promise<string> {
    const index = join(directory, `index-${randomUUID()}`);
    try {
      const source = (
        await projectGit(this.options.root, ["rev-parse", "--git-path", "index"])
      ).trim();
      try {
        await copyFile(resolve(this.options.root, source), index);
        // Rebuild without cached stat/fsmonitor flags: copying the index alone
        // can mistake a same-size, same-timestamp edit for unchanged content.
        const staged = (await projectGit(this.options.root, ["write-tree"], index)).trim();
        await rm(index);
        await projectGit(this.options.root, ["read-tree", staged], index);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      await projectGit(this.options.root, ["add", "-A", "--", "."], index);
      return (await projectGit(this.options.root, ["write-tree"], index)).trim();
    } finally {
      await rm(index, { force: true });
    }
  }

  private async save(directory: string, state: z.infer<typeof StateSchema>): Promise<void> {
    await writePrivateFileAtomically(join(directory, "state.json"), JSON.stringify(state));
  }

  private async state(directory: string) {
    const text = await readPrivateTextFile(join(directory, "state.json"));
    if (text !== null) return StateSchema.parse(JSON.parse(text));
    const tree = await this.snapshot(directory);
    const state = { tree, agentPending: false, generation: 0 };
    await this.save(directory, state);
    return state;
  }

  async start(): Promise<void> {
    const context = createProjectContext({
      cwd: this.options.root,
      git: readProjectGitContext(this.options.root),
    });
    const eventType = "project-context";
    await this.options.localSession.appendEvent(eventType, (sequence, occurredAt) => ({
      eventType,
      eventId: this.options.ids.event(),
      sequence,
      occurredAt,
      cwd: context.cwd,
      branch: context.branch,
      repositoryUrl: context.repositoryUrl,
    }));
    await this.capture("student");
  }

  async beginAgent(messageId: MessageId): Promise<void> {
    await this.capture("student", messageId);
    const directory = await this.location();
    const state = await this.state(directory);
    await this.save(directory, { ...state, agentPending: true });
  }

  private async settle(
    directory: string,
    state: z.infer<typeof StateSchema>,
  ): Promise<z.infer<typeof StateSchema>> {
    const pending = state.pending;
    if (pending === undefined) return state;
    if (pending.actor === "student" && pending.messageId !== undefined) {
      const path = join(directory, `context-${encodeURIComponent(pending.messageId)}.txt`);
      if ((await readPrivateTextFile(path)) === null)
        await writePrivateFileAtomically(
          path,
          `${pending.summary}\n${pending.patch}`.slice(0, 4096),
        );
    }

    await this.options.localSession.appendEvent(
      `project-change:${String(state.generation)}`,
      (sequence, occurredAt) => ({
        eventType: "project-change",
        eventId: this.options.ids.event(),
        sequence,
        occurredAt,
        actor: pending.actor,
        messageId: pending.messageId,
        patch: pending.patch,
        summary: pending.summary,
        truncated: pending.truncated,
      }),
    );
    const next = { tree: pending.tree, generation: state.generation + 1, agentPending: false };
    await this.save(directory, next);
    return next;
  }

  async context(messageId: MessageId): Promise<string> {
    const directory = await this.location();
    const path = join(directory, `context-${encodeURIComponent(messageId)}.txt`);
    const existing = await readPrivateTextFile(path);
    if (existing !== null) return existing;
    await writePrivateFileAtomically(path, "");
    return "";
  }

  async capture(actor: Change["actor"], messageId?: MessageId): Promise<void> {
    const directory = await this.location();
    const previous = await this.settle(directory, await this.state(directory));
    const tree = await this.snapshot(directory);
    if (tree === previous.tree) {
      await this.save(directory, { ...previous, agentPending: false });
      return;
    }
    const patch = await projectGit(this.options.root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      previous.tree,
      tree,
      "--",
      ".",
    ]);
    const summary = await projectGit(this.options.root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      previous.tree,
      tree,
      "--",
      ".",
    ]);
    const pending = {
      tree,
      actor: previous.agentPending && actor !== "agent" ? ("unknown" as const) : actor,
      messageId,
      patch: patch.slice(0, 16_384),
      summary: summary.slice(0, 2048),
      truncated: patch.length > 16_384 || summary.length > 2048,
    };
    const prepared = { ...previous, pending };
    await this.save(directory, prepared);
    await this.settle(directory, prepared);
  }
}
