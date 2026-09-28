import { z } from "zod";
import { SkillIdSchema, Sha256DigestSchema } from "@marea/protocol";
import type { OperatorResources } from "../../governance/operator-application.boundary.js";
import { operatorPayload } from "../../governance/operator-application.boundary.js";
import type { OperatorContext } from "../../governance/authority.js";
import { OperatorDocumentSchema } from "./operator-configuration-parser.js";
import { policyBytes, publishGovernancePolicy } from "./governance-policy-publication.boundary.js";
import type { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import {
  validateOwnerIdentity,
  validateSaveRequest,
} from "../../teaching/authoring/authoring-validation.boundary.js";
import type { SkillSource } from "../../teaching/skills/skill-source.js";
import { summarizeSkill } from "../../teaching/skills/skill-source.js";
import { TeacherDomainError } from "../../identity/errors.js";

const owner = z
  .object({ source: z.enum(["teacher", "center"]), id: z.string() })
  .strict()
  .transform(validateOwnerIdentity);
const readOwner = z.union([owner, z.object({ source: z.literal("marea") }).strict()]);
const kind = z.enum(["didactic", "evaluation"]);
const request = z
  .object({
    kind,
    slug: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).max(256),
  })
  .strict();
const policy = z.object({ document: OperatorDocumentSchema }).strict();

export function createGovernanceOperatorResources(options: {
  readonly core: SkillSource;
  readonly centers: ReadonlyMap<string, SkillAuthoringStore>;
  readonly teachers: ReadonlyMap<string, SkillAuthoringStore>;
}): OperatorResources {
  const centers = new Map(options.centers);
  const teachers = new Map(options.teachers);
  const storeFor = (identity: z.infer<typeof owner>) => {
    const store = (identity.source === "center" ? centers : teachers).get(identity.id);
    if (store === undefined) throw new TeacherDomainError("dashboard.forbidden");
    return store;
  };
  function handle<Q, R>(
    schema: z.ZodType<Q>,
    work: (input: OperatorContext, value: Q) => R | Promise<R>,
  ) {
    return async (input: OperatorContext): Promise<R> => {
      const value = schema.parse(operatorPayload(input));
      const result = await work(input, value);
      input.authority.assertOwned();
      return result;
    };
  }
  return Object.freeze({
    validatePolicy: handle(policy, (_input, value) => {
      policyBytes(value.document);
      return { classes: value.document.classes.length };
    }),
    publishPolicy: handle(policy.extend({ outputPath: z.string() }), (input, value) => {
      publishGovernancePolicy(input.authority, value.outputPath, policyBytes(value.document));
      return { classes: value.document.classes.length };
    }),
    listSkills: handle(z.object({ owner: readOwner, kind }).strict(), (input, value) => {
      if (value.owner.source === "marea") return options.core.list(value.kind);
      return storeFor(value.owner).withReadSource((source) => {
        input.authority.assertOwned();
        return source.list(value.kind);
      });
    }),
    readSkill: handle(
      z.object({ owner: readOwner, skillId: SkillIdSchema }).strict(),
      (input, value) => {
        const prefix =
          value.owner.source === "marea" ? "marea/" : `${value.owner.source}/${value.owner.id}/`;
        if (!value.skillId.startsWith(prefix)) throw new TeacherDomainError("dashboard.forbidden");
        if (value.owner.source === "marea") return options.core.load(value.skillId);
        return storeFor(value.owner).withReadSource((source) => {
          input.authority.assertOwned();
          return source.load(value.skillId);
        });
      },
    ),
    validateSkill: handle(z.object({ owner, request }).strict(), async (_input, value) => {
      const snapshot = validateSaveRequest({ ...value.request, expectedDigest: null });
      const bundle = await storeFor(value.owner).validate(
        snapshot.kind,
        snapshot.slug,
        snapshot.files,
      );
      if (bundle === null) throw new TeacherDomainError("request.conflict");
      return bundle;
    }),
    saveSkill: handle(
      z
        .object({
          owner,
          request: request.extend({ expectedDigest: Sha256DigestSchema.nullable() }),
        })
        .strict(),
      async (input, value) => {
        const snapshot = validateSaveRequest(value.request);
        const store = storeFor(value.owner);
        const guard = () => {
          input.authority.assertOwned();
        };
        const bundle =
          snapshot.expectedDigest === null
            ? await store.create(snapshot, guard)
            : await store.replace(snapshot, guard);
        return summarizeSkill(bundle);
      },
    ),
  });
}
