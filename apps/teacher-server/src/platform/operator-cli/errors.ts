import { ZodError } from "zod";
import { OperationsBoundaryError } from "../operations/canonical-encoder.js";
import { GovernanceResourceError } from "../../governance/errors.js";
import { TeacherDomainError, type TeacherDomainErrorCode } from "../../identity/errors.js";
import {
  TeachingConfigurationError,
  type TeachingConfigurationErrorCode,
} from "../../teaching/configuration/dashboard-errors.js";
import {
  OperatorConfigurationError,
  type OperatorConfigurationErrorCode,
} from "../operator/operator-configuration-errors.js";
import {
  SkillAuthoringError,
  type SkillAuthoringErrorCode,
} from "../../teaching/authoring/errors.js";
import { BundledSkillError } from "../../teaching/skills/errors.js";
import { SkillSnapshotError } from "../../teaching/skills/materialize-skills.js";
import { RecoveryBundleError, type RecoveryErrorCode } from "../recovery/contracts.js";

/** OPERATOR.md exit classes; 130/143 are reserved for signal interruption. */
export type ExitCode = 0 | 2 | 3 | 4 | 5 | 6 | 130 | 143;

export type OperatorCliErrorCode =
  | "invalid-input"
  | "installation-unavailable"
  | "installation-busy"
  | "installation-lost"
  | "prerequisite-unavailable"
  | "output-failed"
  | "ownership-uncertain";

/** Private CLI failures carry only a closed code; paths and causes never become messages. */
export class OperatorCliError extends Error {
  constructor(readonly code: OperatorCliErrorCode) {
    super(code);
    this.name = "OperatorCliError";
  }
}

/** Signal cancellation observed before or after a bounded owned operation settled. */
export class OperatorCliInterrupted extends Error {
  constructor(readonly exitCode: 130 | 143) {
    super("interrupted");
    this.name = "OperatorCliInterrupted";
  }
}

const CLI: Record<OperatorCliErrorCode, Exclude<ExitCode, 0>> = {
  "invalid-input": 2,
  "installation-unavailable": 3,
  "installation-busy": 3,
  "installation-lost": 3,
  "prerequisite-unavailable": 5,
  "output-failed": 6,
  "ownership-uncertain": 6,
};
const DOMAIN: Record<TeacherDomainErrorCode, Exclude<ExitCode, 0>> = {
  "protocol.incompatible": 4,
  "auth.busy": 3,
  "auth.invalid": 3,
  "dashboard.forbidden": 3,
  "invitation.unavailable": 4,
  "request.conflict": 4,
  "run.unavailable": 4,
};
const TEACHING: Record<TeachingConfigurationErrorCode, Exclude<ExitCode, 0>> = {
  "invalid-request": 2,
  "operator-unconfigured": 5,
  "skill-unavailable": 5,
};
const POLICY: Record<OperatorConfigurationErrorCode, Exclude<ExitCode, 0>> = {
  "access-denied": 2,
  "changed-file": 2,
  "duplicate-class-id": 2,
  "invalid-bound": 2,
  "invalid-document": 2,
  "invalid-path": 2,
  "io-failure": 6,
  "not-found": 2,
  "not-regular-file": 2,
  symlink: 2,
  "too-large": 2,
};
const AUTHORING: Record<SkillAuthoringErrorCode, Exclude<ExitCode, 0>> = {
  SKILL_EXISTS: 4,
  SKILL_MISSING: 4,
  STALE_SKILL_DIGEST: 4,
  UNSAFE_AUTHORING_INPUT: 2,
  AUTHORING_LIMIT: 2,
  AUTHORING_WRITE_FAILED: 6,
  AUTHORING_RECOVERY_FAILED: 6,
  ROOT_NOT_EXCLUSIVE: 5,
  UNSAFE_SYMLINK: 5,
};
const SNAPSHOT: Record<SkillSnapshotError["reason"], Exclude<ExitCode, 0>> = {
  duplicate: 2,
  missing: 5,
  changed: 4,
};

const OPERATIONS: Record<OperationsBoundaryError["code"], Exclude<ExitCode, 0>> = {
  "invalid-input": 2,
  limit: 2,
  "stale-preview": 4,
  "blocked-reference": 4,
  uncertain: 6,
};

const RECOVERY: Record<RecoveryErrorCode, Exclude<ExitCode, 0>> = {
  "bundle-input-invalid": 2,
  "bundle-destination-invalid": 4,
  "bundle-manifest-invalid": 5,
  "bundle-filesystem-invalid": 5,
  "bundle-database-invalid": 5,
  "bundle-maintenance-failed": 6,
  "bundle-restore-failed": 6,
};

/** Exit classes come only from accepted error types and closed codes, never message text. */
export function exitCodeFor(error: unknown): Exclude<ExitCode, 0> {
  if (error instanceof OperatorCliInterrupted) return error.exitCode;
  if (error instanceof OperationsBoundaryError) return OPERATIONS[error.code];
  if (error instanceof OperatorCliError) return CLI[error.code];
  if (error instanceof TeacherDomainError) return DOMAIN[error.code];
  if (error instanceof TeachingConfigurationError) return TEACHING[error.code];
  if (error instanceof OperatorConfigurationError) return POLICY[error.code];
  if (error instanceof SkillAuthoringError) return AUTHORING[error.code];
  if (error instanceof SkillSnapshotError) return SNAPSHOT[error.reason];
  if (error instanceof RecoveryBundleError) return RECOVERY[error.code];
  if (error instanceof ZodError || error instanceof GovernanceResourceError) return 2;
  return error instanceof BundledSkillError ? 5 : 6;
}

const DIAGNOSTICS: Record<Exclude<ExitCode, 0>, string> = {
  2: "Invalid command or input.",
  3: "Installation is busy or its authority is unavailable.",
  4: "Operator command conflicts with the current state.",
  5: "Operator prerequisites are unavailable.",
  6: "Operator command failed or its outcome is uncertain.",
  130: "Operator command interrupted; verify its outcome.",
  143: "Operator command terminated; verify its outcome.",
};

export function diagnosticFor(code: Exclude<ExitCode, 0>): string {
  return `${DIAGNOSTICS[code]}\n`;
}
