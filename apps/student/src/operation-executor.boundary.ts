import { Sha256DigestSchema } from "@marea/protocol";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as z from "zod";
import { WorkspaceError, type WorkspaceBackend } from "@marea/workspace-backend";
import type { GuardedWorkspaceWriter } from "./contracts.js";
import type { OperationExecutor, OperationRequest } from "./operation-contracts.js";
import { readPrivateTextFile, writePrivateFileAtomically } from "./filesystem.boundary.js";
import { runProjectCommand } from "./command-runner.boundary.js";

const EditSchema = z
  .object({
    path: z.string().min(1).max(512),
    old_string: z.string().min(1).max(65_536),
    new_string: z.string().max(65_536),
  })
  .strict();
const DeleteSchema = z.object({ path: z.string().min(1).max(512) }).strict();
const CommandSchema = z.object({ command: z.string().min(1).max(4096) }).strict();
const RecordSchema = z
  .object({
    fingerprint: z.string(),
    phase: z.enum(["prepared", "started", "completed"]),
    before: z.string().optional(),
    after: z.string().optional(),
    result: z.string().optional(),
  })
  .strict();
type Record = z.infer<typeof RecordSchema>;
interface Options {
  readonly root: string;
  readonly directory: string;
  readonly workspace: WorkspaceBackend;
  readonly writer: GuardedWorkspaceWriter;
}

export class FileOperationExecutor implements OperationExecutor {
  constructor(private readonly options: Options) {}
  private path(request: OperationRequest): string {
    return join(
      this.options.directory,
      "operations",
      `${encodeURIComponent(request.approvalId)}.json`,
    );
  }
  private fingerprint(request: OperationRequest): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          request.tool,
          Object.entries(request.arguments).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest("hex");
  }
  private async read(request: OperationRequest): Promise<Record | null> {
    const text = await readPrivateTextFile(this.path(request));
    if (text === null) return null;
    const record = RecordSchema.parse(JSON.parse(text));
    if (record.fingerprint !== this.fingerprint(request))
      throw new Error("An operation identity cannot authorize different arguments.");
    return record;
  }
  private async save(request: OperationRequest, record: Record): Promise<void> {
    await mkdir(join(this.options.directory, "operations"), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomically(this.path(request), JSON.stringify(record));
  }
  async prepare(request: OperationRequest): Promise<void> {
    if ((await this.read(request)) !== null) return;
    let record: Record = { fingerprint: this.fingerprint(request), phase: "prepared" };
    if (request.tool === "execute") CommandSchema.parse(request.arguments);
    else if (request.tool === "delete") {
      const { path } = DeleteSchema.parse(request.arguments);
      record = {
        ...record,
        before: await this.options.workspace.readText(path.startsWith("/") ? path : `/${path}`),
      };
    } else {
      const edit = EditSchema.parse(request.arguments);
      const before = await this.options.workspace.readText(
        edit.path.startsWith("/") ? edit.path : `/${edit.path}`,
      );
      if (before.split(edit.old_string).length !== 2)
        throw new Error("The text to replace must occur exactly once. Read the file again.");
      record = { ...record, before, after: before.replace(edit.old_string, () => edit.new_string) };
    }
    await this.save(request, record);
  }
  async execute(request: OperationRequest, signal: AbortSignal): Promise<string> {
    const record = await this.read(request);
    if (record === null) throw new Error("The operation was not prepared for review.");
    if (record.phase === "completed") return z.string().parse(record.result);
    signal.throwIfAborted();
    let result: string;
    if (request.tool === "execute") {
      if (record.phase === "started")
        throw new Error(
          "Command outcome uncertain after interruption. Inspect the project; this command will not be repeated.",
        );
      const { command } = CommandSchema.parse(request.arguments);
      await this.save(request, { ...record, phase: "started" });
      result = await runProjectCommand(this.options.root, command, signal);
    } else if (request.tool === "delete") {
      result = await this.deleteFile(request, record);
    } else {
      const edit = EditSchema.parse(request.arguments);
      const path = edit.path.startsWith("/") ? edit.path.slice(1) : edit.path;
      const before = z.string().parse(record.before);
      const after = z.string().parse(record.after);
      // The writer owns digest revalidation and its recoverable effect journal.
      result = JSON.stringify(
        await this.options.writer.writeApproved(
          `effect:operation:${request.approvalId}`,
          path,
          after,
          Sha256DigestSchema.parse(`sha256:${createHash("sha256").update(before).digest("hex")}`),
        ),
      );
    }
    await this.save(request, { ...record, phase: "completed", result });
    return result;
  }
  private async deleteFile(request: OperationRequest, record: Record): Promise<string> {
    const { path } = DeleteSchema.parse(request.arguments);
    const virtual = path.startsWith("/") ? path : `/${path}`;
    let current: string;
    try {
      current = await this.options.workspace.readText(virtual);
    } catch (error) {
      if (
        record.phase === "started" &&
        error instanceof WorkspaceError &&
        error.code === "not-found"
      )
        return JSON.stringify({ path, operation: "deleted" });
      throw error;
    }
    if (current !== record.before)
      throw new Error("The file changed after review. Request a new deletion.");
    await this.save(request, { ...record, phase: "started" });
    await this.options.workspace.deleteEntry(virtual);
    return JSON.stringify({ path, operation: "deleted" });
  }
}
