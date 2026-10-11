import { expect, it, vi } from "vitest";
import { coordinateSkillChanges } from "./skill-change-coordination.js";
import type { ProductTeachingConfigurationService } from "../../teaching/configuration/dashboard-contracts.js";
import { SkillWorkspaceRequestSchema } from "@marea/protocol";
import { teacher } from "../../teaching/configuration/dashboard-module.fixture.js";
it("serializes selection saves and deletion, releases failed work and lets drafting proceed independently", async () => {
  let complete = () => {
    throw new Error("not started");
  };
  const save = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        complete = () => {
          reject(new Error("save failed"));
        };
      }),
  );
  const classes = vi.fn(),
    read = vi.fn(),
    catalog = vi.fn();
  const teaching = {
    classes,
    read,
    catalog,
    save,
  } as unknown as ProductTeachingConfigurationService;
  expect(coordinateSkillChanges(teaching, undefined)).toEqual({ teachingConfiguration: teaching });
  const execute = vi.fn(async () => {
    await Promise.resolve();
    return {
      protocolVersion: "0.1" as const,
      requestId: "request:q" as never,
      classId: "class:one",
      kind: "delete" as const,
    };
  });
  const coordinated = coordinateSkillChanges(teaching, { execute });
  await coordinated.teachingConfiguration.classes(teacher, {} as never);
  await coordinated.teachingConfiguration.read(teacher, {} as never);
  await coordinated.teachingConfiguration.catalog(teacher, {} as never);
  expect(classes).toHaveBeenCalledWith(teacher, {});
  expect(read).toHaveBeenCalledWith(teacher, {});
  expect(catalog).toHaveBeenCalledWith(teacher, {});
  const saved = coordinated.teachingConfiguration.save(teacher, {} as never);
  const failure = expect(saved).rejects.toThrow("save failed");
  await Promise.resolve();
  expect(save).toHaveBeenCalledWith(teacher, {});
  const base = { protocolVersion: "0.1", requestId: "request:q", classId: "class:one" };
  const removal = SkillWorkspaceRequestSchema.parse({
    ...base,
    kind: "delete",
    skillId: "teacher/t1/testing",
    digest: `sha256:${"a".repeat(64)}`,
    expectedUsage: `sha256:${"b".repeat(64)}`,
  });
  const pending = coordinated.skillWorkspace?.execute(teacher, removal);
  expect(execute).not.toHaveBeenCalled();
  const generation = SkillWorkspaceRequestSchema.parse({
    ...base,
    kind: "generate",
    slug: "testing",
    skillKind: "didactic",
    instructions: "notes",
    locale: "es",
  });
  await coordinated.skillWorkspace?.execute(teacher, generation);
  expect(execute).toHaveBeenCalledWith(teacher, generation);
  complete();
  await failure;
  await pending;
  expect(execute).toHaveBeenLastCalledWith(teacher, removal);
  await coordinated.skillWorkspace?.execute(teacher, removal);
  expect(execute).toHaveBeenCalledTimes(3);
});
