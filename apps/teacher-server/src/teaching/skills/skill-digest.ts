import { createHash } from "node:crypto";

import { Sha256DigestSchema, type Sha256Digest } from "@marea/protocol";

import type { SkillFile } from "./skill-source.js";

/** Canonical file order is supplied by the validated catalog reader. */
export function digestSkillFiles(files: readonly SkillFile[]): Sha256Digest {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.content);
    digest.update("\0");
  }
  return Sha256DigestSchema.parse(`sha256:${digest.digest("hex")}`);
}
