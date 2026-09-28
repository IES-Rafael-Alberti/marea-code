import { Buffer } from "node:buffer";
import { RevisionIdSchema, MAX_TEACHING_CONFIGURATION_BYTES } from "@marea/protocol";
import { z } from "zod";
import type { AdoptionMap } from "./adoption-contracts.js";
import { GovernanceResourceError } from "./errors.js";
import { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";

const ownership = z
  .object({ classId: RevisionIdSchema, centerId: RevisionIdSchema })
  .strict()
  .readonly();
const account = z
  .object({ userId: RevisionIdSchema, ownerCenterId: RevisionIdSchema })
  .strict()
  .readonly();
const administrator = z
  .object({ userId: RevisionIdSchema, centerId: RevisionIdSchema })
  .strict()
  .readonly();
const mapSchema = z
  .object({
    classes: z.array(ownership).max(10000).readonly(),
    accounts: z.array(account).max(10000).readonly(),
    administrators: z.array(administrator).max(10000).readonly(),
  })
  .strict()
  .readonly();

export function parseAdoptionMap(value: unknown): AdoptionMap {
  const result = mapSchema.safeParse(value);
  if (!result.success) throw new TeachingConfigurationError("invalid-request");
  const map = result.data;
  if (
    map.classes.length + map.accounts.length > 10000 ||
    Buffer.byteLength(JSON.stringify(map)) > MAX_TEACHING_CONFIGURATION_BYTES
  )
    throw new GovernanceResourceError();
  if (
    new Set(map.classes.map((item) => item.classId)).size !== map.classes.length ||
    new Set(map.accounts.map((item) => item.userId)).size !== map.accounts.length ||
    new Set(map.administrators.map((item) => JSON.stringify([item.centerId, item.userId]))).size !==
      map.administrators.length
  )
    throw new TeachingConfigurationError("invalid-request");
  return Object.freeze({
    classes: Object.freeze(
      [...map.classes].sort((a, b) =>
        Buffer.compare(Buffer.from(a.classId), Buffer.from(b.classId)),
      ),
    ),
    accounts: Object.freeze(
      [...map.accounts].sort((a, b) =>
        Buffer.compare(Buffer.from(a.userId), Buffer.from(b.userId)),
      ),
    ),
    administrators: Object.freeze(
      [...map.administrators].sort((a, b) =>
        Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))),
      ),
    ),
  });
}
