import type {
  SkillAuthoringCopyRequest,
  SkillAuthoringCopyResponse,
  SkillAuthoringReadRequest,
  SkillAuthoringReadResponse,
  SkillAuthoringSaveRequest,
  SkillAuthoringSaveResponse,
  SkillAuthoringValidateRequest,
  SkillAuthoringValidateResponse,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";

/**
 * Server-owned authoring operations. Authentication and class membership are
 * rechecked by the implementation; owner roots, digests and provenance are
 * derived from trusted host state, never from browser fields or an operator
 * policy. No untrusted owner root is part of this contract.
 */
export interface ProductSkillAuthoringService {
  read(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringReadRequest,
  ): Promise<SkillAuthoringReadResponse>;
  validate(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringValidateRequest,
  ): Promise<SkillAuthoringValidateResponse>;
  save(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringSaveRequest,
  ): Promise<SkillAuthoringSaveResponse>;
  copy(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringCopyRequest,
  ): Promise<SkillAuthoringCopyResponse>;
}
