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
  expect(new OperationMediator("execute").description).toContain("Run a shell command");
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
