import { ConfiguredTeachingRouteSchema } from "../../teaching/configuration/configuration-service.js";
import type { ParsedOperatorDocument } from "./operator-configuration-adapter.js";
import type { TeachingOperatorPolicy } from "../../teaching/configuration/dashboard-contracts.js";
import { z } from "zod";
import { RevisionIdSchema, TeacherToolPolicySchema } from "@marea/protocol";

import { OperatorConfigurationError } from "./operator-configuration-errors.js";

const OperatorClassSchema = z
  .object({
    classId: RevisionIdSchema,
    policy: z
      .object({
        route: ConfiguredTeachingRouteSchema,
        teacherToolPolicy: TeacherToolPolicySchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const OperatorDocumentSchema = z
  .object({
    version: z.literal(1),
    classes: z.array(OperatorClassSchema).readonly(),
  })
  .strict()
  .readonly();

function invalidDocument(message: string): OperatorConfigurationError {
  return new OperatorConfigurationError("invalid-document", message);
}

function completePolicy(entry: z.infer<typeof OperatorClassSchema>): TeachingOperatorPolicy {
  if (entry.policy.route.providerRoute.budget === undefined) {
    throw invalidDocument("Operator route budget is required.");
  }
  return entry.policy as TeachingOperatorPolicy;
}

export function parseOperatorDocument(document: unknown): ParsedOperatorDocument {
  const parsed = OperatorDocumentSchema.safeParse(document);
  if (!parsed.success) throw invalidDocument("Operator configuration document is invalid.");
  const classes = new Map<string, TeachingOperatorPolicy>();
  for (const entry of parsed.data.classes) {
    if (classes.has(entry.classId)) {
      throw new OperatorConfigurationError(
        "duplicate-class-id",
        "Operator configuration contains a duplicate class identity.",
      );
    }
    classes.set(entry.classId, completePolicy(entry));
  }
  return {
    version: 1,
    forClass: (classId) => {
      const policy = classes.get(classId);
      return policy === undefined ? null : structuredClone(policy);
    },
  };
}
