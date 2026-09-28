export type BundledSkillErrorCode =
  | "DUPLICATE_SKILL_ID"
  | "FILE_TOO_LARGE"
  | "INVALID_FRONTMATTER"
  | "INVALID_SKILL_NAME"
  | "INVALID_TEXT_ENCODING"
  | "MISSING_SKILL_FILE"
  | "PATH_OUTSIDE_ROOT"
  | "READ_FAILED"
  | "ROOT_NOT_DIRECTORY"
  | "UNSAFE_PATH"
  | "UNSAFE_SYMLINK"
  | "UNSUPPORTED_ENTRY_TYPE"
  | "UNSUPPORTED_SKILL_LAYOUT"
  | "UNSUPPORTED_FILE_TYPE";

export class BundledSkillError extends Error {
  readonly code: BundledSkillErrorCode;
  readonly location: string;

  constructor(code: BundledSkillErrorCode, location: string, message: string) {
    super(message);
    this.name = "BundledSkillError";
    this.code = code;
    this.location = location;
  }
}
