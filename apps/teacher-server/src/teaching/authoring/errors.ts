export type SkillAuthoringErrorCode =
  | "SKILL_EXISTS"
  | "SKILL_MISSING"
  | "STALE_SKILL_DIGEST"
  | "UNSAFE_AUTHORING_INPUT"
  | "AUTHORING_LIMIT"
  | "AUTHORING_WRITE_FAILED"
  | "AUTHORING_RECOVERY_FAILED"
  | "ROOT_NOT_EXCLUSIVE"
  | "UNSAFE_SYMLINK";

export class SkillAuthoringError extends Error {
  readonly code: SkillAuthoringErrorCode;
  readonly location: string;

  constructor(code: SkillAuthoringErrorCode, location: string, message: string) {
    super(message);
    this.name = "SkillAuthoringError";
    this.code = code;
    this.location = location;
  }
}
