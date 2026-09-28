import { expectTypeOf, it } from "vitest";

import type {
  SkillAuthoringCopyRequest,
  SkillAuthoringCopyResponse,
  SkillAuthoringReadRequest,
  SkillAuthoringReadResponse,
  SkillAuthoringSaveResponse,
  SkillAuthoringValidateRequest,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { ProductSkillAuthoringService } from "./dashboard-contracts.js";

type ServiceMethod = (
  identity: AuthenticatedIdentity,
  request: SkillAuthoringReadRequest,
) => Promise<SkillAuthoringReadResponse>;

it("types authoring operations over authenticated identity and protocol values", () => {
  expectTypeOf<ProductSkillAuthoringService["read"]>().toEqualTypeOf<ServiceMethod>();
  expectTypeOf<ProductSkillAuthoringService["validate"]>()
    .parameter(1)
    .toEqualTypeOf<SkillAuthoringValidateRequest>();
  expectTypeOf<
    ProductSkillAuthoringService["save"]
  >().returns.resolves.toEqualTypeOf<SkillAuthoringSaveResponse>();
  expectTypeOf<ProductSkillAuthoringService["copy"]>()
    .parameter(1)
    .toEqualTypeOf<SkillAuthoringCopyRequest>();
  expectTypeOf<
    ProductSkillAuthoringService["copy"]
  >().returns.resolves.toEqualTypeOf<SkillAuthoringCopyResponse>();
  expectTypeOf<ProductSkillAuthoringService["validate"]>()
    .returns.resolves.toHaveProperty("kind")
    .toEqualTypeOf<"skill-authoring-validated">();
  expectTypeOf<ProductSkillAuthoringService["save"]>()
    .returns.resolves.toHaveProperty("kind")
    .toEqualTypeOf<"skill-authoring-saved">();
  expectTypeOf<ProductSkillAuthoringService["copy"]>()
    .returns.resolves.toHaveProperty("kind")
    .toEqualTypeOf<"skill-authoring-copied">();
});
