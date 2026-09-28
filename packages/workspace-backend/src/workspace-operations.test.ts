import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceError, type WorkspaceBackend } from "./contracts.js";
import { openGuardedWorkspace } from "./guarded-workspace.js";

describe("guarded workspace operations", () => {
  let containerPath: string;
  let rootPath: string;
  let workspace: WorkspaceBackend;

  beforeEach(async () => {
    containerPath = await mkdtemp(join(tmpdir(), "marea-workspace-operations-"));
    rootPath = join(containerPath, "project");
    await mkdir(rootPath);
    workspace = await openGuardedWorkspace({ rootPath });
  });

  afterEach(async () => {
    await chmod(rootPath, 0o700).catch(() => undefined);
    await rm(containerPath, { force: true, recursive: true });
  });

  it("writes and reads UTF-8 text through the virtual namespace", async () => {
    await workspace.writeText("/src/main.ts", "const greeting = 'hola';\n", {
      createParents: true,
    });

    await expect(workspace.readText("/src/main.ts")).resolves.toBe("const greeting = 'hola';\n");
    await expect(readFile(join(rootPath, "src", "main.ts"), "utf8")).resolves.toBe(
      "const greeting = 'hola';\n",
    );
    expect(await readdir(join(rootPath, "src"))).toEqual(["main.ts"]);
  });

  it("replaces a regular file atomically and preserves its permission bits", async () => {
    const filePath = join(rootPath, "script.sh");
    await writeFile(filePath, "old\n", { mode: 0o744 });

    await workspace.writeText("/script.sh", "new\n");

    expect(await readFile(filePath, "utf8")).toBe("new\n");
    expect((await stat(filePath)).mode & 0o777).toBe(0o744);
    expect((await readdir(rootPath)).filter((name) => name.startsWith(".marea-"))).toEqual([]);
  });

  it("requires existing parents unless creation is explicit", async () => {
    await expect(workspace.writeText("/missing/file.ts", "content")).rejects.toEqual(
      new WorkspaceError("not-found", "write"),
    );

    await workspace.writeText("/missing/nested/file.ts", "content", { createParents: true });

    await expect(workspace.readText("/missing/nested/file.ts")).resolves.toBe("content");
  });

  it("rejects a regular file used as a parent", async () => {
    await writeFile(join(rootPath, "parent"), "content");

    await expect(
      workspace.writeText("/parent/child.ts", "content", { createParents: true }),
    ).rejects.toEqual(new WorkspaceError("not-directory", "write"));
  });

  it("enforces write and read limits in UTF-8 bytes", async () => {
    const limited = await openGuardedWorkspace({
      rootPath,
      limits: { maxReadBytes: 3, maxWriteBytes: 3 },
    });
    await writeFile(join(rootPath, "large.txt"), "four");

    await limited.writeText("/three.txt", "€");
    await limited.writeText("/three-ascii.txt", "abc");
    await expect(limited.readText("/three.txt")).resolves.toBe("€");
    await expect(limited.readText("/three-ascii.txt")).resolves.toBe("abc");
    await expect(limited.writeText("/large-write.txt", "éé")).rejects.toEqual(
      new WorkspaceError("write-limit-exceeded", "write"),
    );
    await expect(limited.readText("/large.txt")).rejects.toEqual(
      new WorkspaceError("read-limit-exceeded", "read"),
    );
  });

  it("rejects oversized text before allocating its UTF-8 representation", async () => {
    const limited = await openGuardedWorkspace({ rootPath, limits: { maxWriteBytes: 1 } });
    const content = "a".repeat(100_000);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    try {
      await expect(limited.writeText("/large.txt", content)).rejects.toEqual(
        new WorkspaceError("write-limit-exceeded", "write"),
      );
      expect(encode).not.toHaveBeenCalledWith(content);
    } finally {
      encode.mockRestore();
    }
  });

  it("rejects invalid UTF-8 and non-file reads", async () => {
    await writeFile(join(rootPath, "binary"), Uint8Array.of(0xff));
    await mkdir(join(rootPath, "directory"));

    await expect(workspace.readText("/binary")).rejects.toEqual(
      new WorkspaceError("unsupported-text-encoding", "read"),
    );
    await expect(workspace.readText("/directory")).rejects.toEqual(
      new WorkspaceError("not-regular-file", "read"),
    );
    await expect(workspace.readText("/missing")).rejects.toEqual(
      new WorkspaceError("not-found", "read"),
    );
  });

  it("lists supported entries deterministically with virtual metadata", async () => {
    await mkdir(join(rootPath, "z-directory"));
    await writeFile(join(rootPath, "a-file.txt"), "abc");

    const entries = await workspace.list("/");

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: "/a-file.txt", kind: "file", size: 3 });
    expect(entries[1]).toMatchObject({ path: "/z-directory", kind: "directory", size: 0 });
    expect(entries.every((entry) => !Number.isNaN(Date.parse(entry.modifiedAt)))).toBe(true);
  });

  it("enforces the directory-entry limit", async () => {
    const limited = await openGuardedWorkspace({
      rootPath,
      limits: { maxDirectoryEntries: 1 },
    });
    await writeFile(join(rootPath, "one"), "1");
    await writeFile(join(rootPath, "two"), "2");

    await expect(limited.list("/")).rejects.toEqual(
      new WorkspaceError("directory-limit-exceeded", "list"),
    );
  });

  it("accepts a directory whose entry count is exactly the configured limit", async () => {
    const limited = await openGuardedWorkspace({
      rootPath,
      limits: { maxDirectoryEntries: 2 },
    });
    await writeFile(join(rootPath, "one"), "1");
    await writeFile(join(rootPath, "two"), "2");

    await expect(limited.list("/")).resolves.toHaveLength(2);
  });

  it("rejects listing a regular file", async () => {
    await writeFile(join(rootPath, "file"), "content");

    await expect(workspace.list("/file")).rejects.toEqual(
      new WorkspaceError("not-directory", "list"),
    );
  });

  it("applies unambiguous single and all-occurrence edits", async () => {
    await writeFile(join(rootPath, "single.txt"), "before middle after");
    await writeFile(join(rootPath, "all.txt"), "x-x-x");

    await expect(
      workspace.editText("/single.txt", { expected: "middle", replacement: "center" }),
    ).resolves.toBe(1);
    await expect(
      workspace.editText("/all.txt", { expected: "x", replacement: "long", occurrence: "all" }),
    ).resolves.toBe(3);
    await expect(workspace.readText("/single.txt")).resolves.toBe("before center after");
    await expect(workspace.readText("/all.txt")).resolves.toBe("long-long-long");
  });

  it("rejects empty, missing, and ambiguous edit matches", async () => {
    await writeFile(join(rootPath, "file.txt"), "same same");
    await writeFile(join(rootPath, "empty-content.txt"), "");

    await expect(
      workspace.editText("/empty-content.txt", { expected: "", replacement: "x" }),
    ).rejects.toEqual(new WorkspaceError("edit-conflict", "edit"));
    await expect(
      workspace.editText("/file.txt", { expected: "absent", replacement: "x" }),
    ).rejects.toEqual(new WorkspaceError("edit-conflict", "edit"));
    await expect(
      workspace.editText("/file.txt", {
        expected: "absent",
        replacement: "x",
        occurrence: "all",
      }),
    ).rejects.toEqual(new WorkspaceError("edit-conflict", "edit"));
    await expect(
      workspace.editText("/file.txt", { expected: "same", replacement: "x" }),
    ).rejects.toEqual(new WorkspaceError("edit-conflict", "edit"));
  });

  it("enforces the write limit on the resulting edit", async () => {
    await writeFile(join(rootPath, "file.txt"), "a");
    const limited = await openGuardedWorkspace({ rootPath, limits: { maxWriteBytes: 2 } });

    await expect(
      limited.editText("/file.txt", { expected: "a", replacement: "long" }),
    ).rejects.toEqual(new WorkspaceError("write-limit-exceeded", "edit"));
  });

  it("deletes regular files and empty directories but not non-empty directories", async () => {
    await writeFile(join(rootPath, "file"), "content");
    await mkdir(join(rootPath, "empty"));
    await mkdir(join(rootPath, "non-empty"));
    await writeFile(join(rootPath, "non-empty", "child"), "content");

    await workspace.deleteEntry("/file");
    await workspace.deleteEntry("/empty");

    await expect(lstat(join(rootPath, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(rootPath, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(workspace.deleteEntry("/non-empty")).rejects.toEqual(
      new WorkspaceError("directory-not-empty", "delete"),
    );
  });

  it("renames files and directories without overwriting", async () => {
    await writeFile(join(rootPath, "source"), "content");
    await mkdir(join(rootPath, "source-directory"));

    await workspace.renameEntry("/source", "/destination");
    await workspace.renameEntry("/source-directory", "/destination-directory");

    await expect(workspace.readText("/destination")).resolves.toBe("content");
    await expect(workspace.list("/destination-directory")).resolves.toEqual([]);
    await expect(workspace.renameEntry("/destination", "/destination-directory")).rejects.toEqual(
      new WorkspaceError("already-exists", "rename"),
    );
  });

  it("does not create a missing destination parent while renaming", async () => {
    await writeFile(join(rootPath, "source"), "content");

    await expect(workspace.renameEntry("/source", "/missing/destination")).rejects.toEqual(
      new WorkspaceError("not-found", "rename"),
    );
  });

  it.each(["deleteEntry", "renameSource", "renameDestination"] as const)(
    "never mutates the virtual root through %s",
    async (operation) => {
      const action =
        operation === "deleteEntry"
          ? workspace.deleteEntry("/")
          : operation === "renameSource"
            ? workspace.renameEntry("/", "/new")
            : workspace.renameEntry("/source", "/");
      await expect(action).rejects.toEqual(
        new WorkspaceError("invalid-path", operation === "deleteEntry" ? "delete" : "rename"),
      );
    },
  );

  it("treats POSIX-looking host paths as virtual and cannot read the host target", async () => {
    const outsidePath = join(containerPath, "outside-secret");
    await writeFile(outsidePath, "secret");

    await expect(workspace.readText(outsidePath)).rejects.toEqual(
      new WorkspaceError("not-found", "read"),
    );
  });

  it("rejects symbolic links as ancestors, targets, and listed children", async ({ skip }) => {
    const outsidePath = join(containerPath, "outside");
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, "secret"), "secret");
    try {
      await symlink(outsidePath, join(rootPath, "linked-directory"), "dir");
    } catch {
      skip("Symbolic links are unavailable on this platform.");
    }
    await symlink(join(outsidePath, "secret"), join(rootPath, "linked-file"), "file");
    await writeFile(join(rootPath, "inside-target"), "inside");
    await symlink(join(rootPath, "inside-target"), join(rootPath, "inside-link"), "file");

    await expect(workspace.readText("/linked-directory/secret")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
    await expect(workspace.writeText("/linked-directory/new", "content")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "write"),
    );
    await expect(workspace.readText("/linked-file")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
    await expect(workspace.readText("/inside-link")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
    await expect(workspace.writeText("/linked-file", "content")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "write"),
    );
    await expect(workspace.deleteEntry("/linked-file")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "delete"),
    );
    await expect(workspace.renameEntry("/linked-file", "/renamed")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "rename"),
    );
    await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("unsafe-entry", "list"));
  });

  it("rejects hard-linked regular files", async () => {
    const outsidePath = join(containerPath, "outside-file");
    await writeFile(outsidePath, "shared");
    await link(outsidePath, join(rootPath, "hard-link"));

    await expect(workspace.readText("/hard-link")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
    await expect(workspace.writeText("/hard-link", "changed")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "write"),
    );
    await expect(
      workspace.editText("/hard-link", { expected: "shared", replacement: "x" }),
    ).rejects.toEqual(new WorkspaceError("unsafe-entry", "edit"));
    await expect(workspace.deleteEntry("/hard-link")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "delete"),
    );
    await expect(workspace.renameEntry("/hard-link", "/renamed")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "rename"),
    );
  });

  it.runIf(process.platform !== "win32")("rejects unsafe discovered names", async () => {
    const unsafeName = "unsafe\\name";
    await writeFile(join(rootPath, unsafeName), "content");
    await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("invalid-path", "list"));
  });
});
