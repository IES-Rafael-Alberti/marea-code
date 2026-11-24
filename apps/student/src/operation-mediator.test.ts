import { expect, it } from "vitest";
import { OperationMediator } from "./operation-mediator.js";
it.each(["execute", "edit_file", "delete"] as const)(
  "consumes %s authorizations once and only for identical arguments",
  async (name) => {
    const mediator = new OperationMediator(name);
    expect(mediator.name).toBe(`marea_${name}`);
    await expect(mediator.execute({ command: "x" })).rejects.toThrow("authorization");
    mediator.authorize({ command: "x" }, "recorded");
    await expect(mediator.execute({ command: "y" })).rejects.toThrow("authorization");
    await expect(mediator.execute({ command: "x" })).rejects.toThrow("authorization");
    mediator.authorize({ command: "x" }, "recorded");
    await expect(mediator.execute({ command: "x", extra: "y" })).rejects.toThrow("authorization");
    mediator.authorize({ command: "x" }, "recorded");
    expect(await mediator.execute({ command: "x" })).toBe("recorded");
    await expect(mediator.execute({ command: "x" })).rejects.toThrow("authorization");
  },
);
it("describes the actual operation and rejects mixed matching/mismatching arguments", async () => {
  const execute = new OperationMediator("execute").description;
  expect(execute).toContain("Run a shell command");
  expect(execute).toContain("Deadline 10 minutes;");
  expect(execute).toContain("first 4096 and the last 12288 characters");
  expect(new OperationMediator("delete").description).toContain("Delete one project text file");
  const edit = new OperationMediator("edit_file");
  expect(edit.description).toContain("Replace an exact unique text fragment");
  edit.authorize({ path: "main.ts", old_string: "before" }, "result");
  await expect(edit.execute({ path: "main.ts", old_string: "other" })).rejects.toThrow(
    "authorization",
  );
  edit.authorize({ path: "main.ts", old_string: "before" }, "result");
  await expect(edit.execute({ path: "main.ts" })).rejects.toThrow("authorization");
});

it("names the interpreter of this machine in the command description", () => {
  const windows = new OperationMediator("execute", "win32").description;
  expect(windows).toContain(
    'Shell: this computer runs Windows, so commands run in cmd.exe, not PowerShell or bash. Use cmd syntax (dir, type, cd /d, del, &&); quote paths with spaces in double quotes ("my file.txt"), never single quotes; one command per call is clearest.',
  );
  for (const platform of ["darwin", "linux"] as const) {
    const posix = new OperationMediator("execute", platform).description;
    expect(posix).toContain(
      "Shell: this computer runs commands with /bin/sh. Quote paths with spaces.",
    );
    expect(posix).not.toContain("cmd.exe");
  }
  expect(new OperationMediator("delete", "win32").description).toContain("Arguments: file_path.");
  expect(new OperationMediator("edit_file").description).toContain(
    "Arguments: file_path, old_string, new_string.",
  );
});
