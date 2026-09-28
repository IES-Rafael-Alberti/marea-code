import { Sha256DigestSchema, SnapshotIdSchema } from "@marea/protocol";

export const DIGEST = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);

export const snapshot = {
  id: SnapshotIdSchema.parse("snapshot:1"),
  agentMode: "tutoring" as const,
  modelAlias: "marea" as const,
  prompt: { version: "prompt:1", digest: DIGEST, content: "Help the student." },
  didacticSkills: [],
  teacherToolPolicy: { version: "tools:1", restrictions: [] },
};
