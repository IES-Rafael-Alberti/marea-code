import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillAuthoringStore,
  type SkillAuthoringFile,
  type SkillSaveRequest,
} from "./skill-authoring-store.boundary.js";
import type { SkillKind } from "../skills/skill-source.js";

export const roots: string[] = [];
export const owner = { source: "teacher", id: "owner-1" } as const;

export async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marea-authoring-"));
  roots.push(root);
  const store = new SkillAuthoringStore(root, owner);
  await store.initialize();
  return root;
}

export async function symlinkedKindRoot() {
  const root = await mkdtemp(join(tmpdir(), "marea-authoring-"));
  roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), "marea-outside-"));
  roots.push(outside);
  await symlink(outside, join(root, "evaluation"));
  return { root, outside, store: new SkillAuthoringStore(root, owner) };
}

export function skill(
  name: string,
  description = "Practice testing",
  resources: readonly SkillAuthoringFile[] = [],
): readonly SkillAuthoringFile[] {
  return [
    {
      path: "SKILL.md",
      content: `---\nname: ${name}\ndescription: ${description}\n---\n\nTeach testing.\n`,
    },
    ...resources,
  ];
}

export function saveRequest(
  kind: SkillKind,
  slug: string,
  files: readonly SkillAuthoringFile[],
  expectedDigest: SkillSaveRequest["expectedDigest"] = null,
): SkillSaveRequest {
  return { kind, slug, files, expectedDigest };
}
