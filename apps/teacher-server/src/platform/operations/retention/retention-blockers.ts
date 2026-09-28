import type * as z from "zod";

import { BlockerSchema, type TargetRef } from "../schemas.js";

export type RetentionBlocker = z.infer<typeof BlockerSchema>;

export function blocker(
  code: RetentionBlocker["code"],
  target: TargetRef | null,
  detailCode: string,
): RetentionBlocker {
  return BlockerSchema.parse({ code, target, detailCode });
}
