import * as z from "zod";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalIdSchema } from "@marea/protocol";
import { openGuardedWorkspace } from "@marea/workspace-backend";
import { FileOperationExecutor } from "./operation-executor.boundary.js";
import { createCrashSafeWorkspaceWriter } from "./workspace-writer.js";
import { createFileEffectLedger } from "./effect-ledger.boundary.js";
import type { OperationRequest } from "./operation-contracts.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marea-operation-project-"));
  const directory = await mkdtemp(join(tmpdir(), "marea-operation-state-"));
  roots.push(root, directory);
  const workspace = await openGuardedWorkspace({ rootPath: root });
  const writer = createCrashSafeWorkspaceWriter({
    workspace,
    ledger: createFileEffectLedger(directory),
  });
  return {
    root,
    directory,
    workspace,
    operations: new FileOperationExecutor({ root, directory, workspace, writer }),
  };
}
const request: OperationRequest = {
  approvalId: ApprovalIdSchema.parse("approval:edit"),
  tool: "edit_file",
  arguments: { path: "main.ts", old_string: "before", new_string: "after" },
  summary: "Replace text",
};
it("edits an exact fragment, persists the effect and does not replay after completion", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "main.ts"), "before\n");
  await f.operations.prepare(request);
  expect(await readFile(join(f.root, "main.ts"), "utf8")).toBe("before\n");
  const result = await f.operations.execute(request, new AbortController().signal);
  expect(await readFile(join(f.root, "main.ts"), "utf8")).toBe("after\n");
  await writeFile(join(f.root, "main.ts"), "student changes later\n");
  expect(await f.operations.execute(request, new AbortController().signal)).toBe(result);
  expect(await readFile(join(f.root, "main.ts"), "utf8")).toBe("student changes later\n");
});
it("rejects stale previews, ambiguous edits, traversal, changed identity and pre-aborted effects", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "main.ts"), "before before");
  await expect(f.operations.prepare(request)).rejects.toThrow("exactly once");
  await writeFile(join(f.root, "main.ts"), "before");
  await f.operations.prepare(request);
  await expect(
    f.operations.prepare({
      ...request,
      arguments: { ...request.arguments, new_string: "different" },
    }),
  ).rejects.toThrow("different arguments");
  await expect(f.operations.execute(request, AbortSignal.abort())).rejects.toThrow();
  await writeFile(join(f.root, "main.ts"), "student changed it");
  await expect(f.operations.execute(request, new AbortController().signal)).rejects.toThrow(
    "changed after review",
  );
  await expect(
    f.operations.prepare({
      ...request,
      approvalId: ApprovalIdSchema.parse("approval:escape"),
      arguments: { ...request.arguments, path: "../secret" },
    }),
  ).rejects.toThrow();
});
it("records a shell result and refuses to repeat an interrupted command", async () => {
  const f = await fixture();
  const command: OperationRequest = {
    approvalId: ApprovalIdSchema.parse("approval:command"),
    tool: "execute",
    arguments: { command: "printf done >> result.txt; printf output" },
    summary: "Synthetic command",
  };
  await f.operations.prepare(command);
  const result = await f.operations.execute(command, new AbortController().signal);
  expect(JSON.parse(result)).toMatchObject({ exitCode: 0, output: "output", stopped: false });
  expect(await f.operations.execute(command, new AbortController().signal)).toBe(result);
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("done");
  const path = join(f.directory, "operations", `${encodeURIComponent(command.approvalId)}.json`);
  const record = z
    .object({ fingerprint: z.string() })
    .parse(JSON.parse(await readFile(path, "utf8")));
  await writeFile(path, JSON.stringify({ fingerprint: record.fingerprint, phase: "started" }), {
    mode: 0o600,
  });
  await expect(f.operations.execute(command, new AbortController().signal)).rejects.toThrow(
    "outcome uncertain",
  );
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("done");
});
it("requires review and recovers a partial edit after its durable filesystem effect", async () => {
  const f = await fixture();
  const absolute = { ...request, arguments: { ...request.arguments, path: "/main.ts" } };
  await writeFile(join(f.root, "main.ts"), "before");
  await expect(f.operations.execute(absolute, new AbortController().signal)).rejects.toThrow(
    "not prepared",
  );
  await f.operations.prepare(absolute);
  await f.operations.prepare(absolute);
  const path = join(f.directory, "operations", `${encodeURIComponent(request.approvalId)}.json`);
  const prepared = z
    .object({ fingerprint: z.string(), before: z.string(), after: z.string() })
    .parse(JSON.parse(await readFile(path, "utf8")));
  const result = await f.operations.execute(absolute, new AbortController().signal);
  await writeFile(path, JSON.stringify({ ...prepared, phase: "started" }));
  expect(await f.operations.execute(absolute, new AbortController().signal)).toBe(result);
  expect(await readFile(join(f.root, "main.ts"), "utf8")).toBe("after");
});
it("deletes only the reviewed file and recovers an interrupted deletion without deleting a replacement", async () => {
  const f = await fixture();
  const deletion: OperationRequest = {
    approvalId: ApprovalIdSchema.parse("approval:delete"),
    tool: "delete",
    arguments: { path: "/main.ts" },
    summary: "Delete main.ts",
  };
  await writeFile(join(f.root, "main.ts"), "reviewed contents");
  await f.operations.prepare(deletion);
  await writeFile(join(f.root, "main.ts"), "changed contents");
  await expect(f.operations.execute(deletion, new AbortController().signal)).rejects.toThrow(
    "changed after review",
  );
  await writeFile(join(f.root, "main.ts"), "reviewed contents");
  const path = join(f.directory, "operations", `${encodeURIComponent(deletion.approvalId)}.json`);
  const prepared = z
    .object({ fingerprint: z.string(), before: z.string() })
    .parse(JSON.parse(await readFile(path, "utf8")));
  const result = await f.operations.execute(deletion, new AbortController().signal);
  expect(JSON.parse(result)).toEqual({ path: "/main.ts", operation: "deleted" });
  await expect(readFile(join(f.root, "main.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, JSON.stringify({ ...prepared, phase: "started" }));
  expect(await f.operations.execute(deletion, new AbortController().signal)).toBe(result);
  await writeFile(join(f.root, "main.ts"), "student replacement");
  expect(await f.operations.execute(deletion, new AbortController().signal)).toBe(result);
  expect(await readFile(join(f.root, "main.ts"), "utf8")).toBe("student replacement");
});
it("refuses a missing or non-file deletion target before or after review", async () => {
  const f = await fixture();
  const deletion: OperationRequest = {
    approvalId: ApprovalIdSchema.parse("approval:relative-delete"),
    tool: "delete",
    arguments: { path: "missing.ts" },
    summary: "Delete",
  };
  await expect(f.operations.prepare(deletion)).rejects.toThrow();
  await writeFile(join(f.root, "missing.ts"), "reviewed");
  await f.operations.prepare(deletion);
  await rm(join(f.root, "missing.ts"));
  await expect(f.operations.execute(deletion, new AbortController().signal)).rejects.toThrow();
});
it("normalizes argument order and validates shell arguments before persisting authorization", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "main.ts"), "before");
  await f.operations.prepare(request);
  const reordered = {
    ...request,
    arguments: { new_string: "after", old_string: "before", path: "main.ts" },
  };
  await f.operations.prepare(reordered);
  expect(
    JSON.parse(await f.operations.execute(reordered, new AbortController().signal)),
  ).toMatchObject({ path: "main.ts" });
  for (const arguments_ of [
    { command: "" },
    { command: "x".repeat(4097) },
    { command: "true", extra: "unreviewed" },
  ]) {
    await expect(
      f.operations.prepare({
        ...request,
        approvalId: ApprovalIdSchema.parse("approval:invalid-command"),
        tool: "execute",
        arguments: arguments_,
      }),
    ).rejects.toThrow();
  }
});
it("persists irreversible command/deletion intent before crossing the effect boundary", async () => {
  const f = await fixture();
  const commands = await import("./command-runner.boundary.js");
  const run = vi
    .spyOn(commands, "runProjectCommand")
    .mockRejectedValueOnce(new Error("command interruption"));
  const command = { ...request, tool: "execute" as const, arguments: { command: "synthetic" } };
  try {
    await f.operations.prepare(command);
    await expect(f.operations.execute(command, new AbortController().signal)).rejects.toThrow(
      "command interruption",
    );
    await expect(f.operations.execute(command, new AbortController().signal)).rejects.toThrow(
      "outcome uncertain",
    );
    expect(run).toHaveBeenCalledOnce();
  } finally {
    run.mockRestore();
  }
  const deletion = {
    ...request,
    approvalId: ApprovalIdSchema.parse("approval:delete-interrupted"),
    tool: "delete" as const,
    arguments: { path: "main.ts" },
  };
  await writeFile(join(f.root, "main.ts"), "reviewed");
  await f.operations.prepare(deletion);
  const remove = vi
    .spyOn(f.workspace, "deleteEntry")
    .mockRejectedValueOnce(new Error("delete interruption"));
  await expect(f.operations.execute(deletion, new AbortController().signal)).rejects.toThrow(
    "delete interruption",
  );
  remove.mockRestore();
  await rm(join(f.root, "main.ts"));
  expect(JSON.parse(await f.operations.execute(deletion, new AbortController().signal))).toEqual({
    path: "main.ts",
    operation: "deleted",
  });
});

it("does not interpret a different filesystem failure as a recovered deletion", async () => {
  const f = await fixture();
  const deletion = { ...request, tool: "delete" as const, arguments: { path: "main.ts" } };
  await writeFile(join(f.root, "main.ts"), "reviewed");
  await f.operations.prepare(deletion);
  const path = join(f.directory, "operations", `${encodeURIComponent(deletion.approvalId)}.json`);
  const record = z
    .object({ fingerprint: z.string(), before: z.string() })
    .parse(JSON.parse(await readFile(path, "utf8")));
  await writeFile(path, JSON.stringify({ ...record, phase: "started" }));
  await rm(join(f.root, "main.ts"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(f.root, "main.ts"));
  await expect(f.operations.execute(deletion, new AbortController().signal)).rejects.toThrow();
});
