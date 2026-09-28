import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GovernanceResourceError } from "../../governance/errors.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { TeachingConfigurationError } from "../../teaching/configuration/dashboard-errors.js";
import { OperatorConfigurationError } from "../operator/operator-configuration-errors.js";
import { SkillAuthoringError } from "../../teaching/authoring/errors.js";
import { BundledSkillError } from "../../teaching/skills/errors.js";
import { SkillSnapshotError } from "../../teaching/skills/materialize-skills.js";
import { SkillIdSchema } from "@marea/protocol";
import { OperationsBoundaryError } from "../operations/canonical-encoder.js";
import { RecoveryBundleError } from "../recovery/contracts.js";
import { diagnosticFor, exitCodeFor, OperatorCliError, OperatorCliInterrupted } from "./errors.js";

describe("typed operator CLI exit classes", () => {
  it("maps recovery bundle failures to closed exit classes", () => {
    for (const [code, exit] of [
      ["bundle-input-invalid", 2],
      ["bundle-destination-invalid", 4],
      ["bundle-manifest-invalid", 5],
      ["bundle-filesystem-invalid", 5],
      ["bundle-database-invalid", 5],
      ["bundle-maintenance-failed", 6],
      ["bundle-restore-failed", 6],
    ] as const)
      expect(exitCodeFor(new RecoveryBundleError(code, "private detail"))).toBe(exit);
  });
  it("distinguishes invalid selections, absent prerequisites and changed skill revisions", () => {
    for (const [reason, exit] of [
      ["duplicate", 2],
      ["missing", 5],
      ["changed", 4],
    ] as const)
      expect(
        exitCodeFor(new SkillSnapshotError(SkillIdSchema.parse("teacher/private/example"), reason)),
      ).toBe(exit);
  });
  it("maps OPERATIONS operations boundary codes to stable exit classes", () => {
    for (const [code, exit] of [
      ["invalid-input", 2],
      ["limit", 2],
      ["stale-preview", 4],
      ["blocked-reference", 4],
      ["uncertain", 6],
    ] as const)
      expect(exitCodeFor(new OperationsBoundaryError(code, "private detail"))).toBe(exit);
  });
  it("maps closed CLI codes and interruption without reading messages", () => {
    const cases = [
      ["invalid-input", 2],
      ["installation-unavailable", 3],
      ["installation-busy", 3],
      ["installation-lost", 3],
      ["prerequisite-unavailable", 5],
      ["output-failed", 6],
      ["ownership-uncertain", 6],
    ] as const;
    for (const [code, exit] of cases) {
      const error = new OperatorCliError(code);
      expect([exitCodeFor(error), error.code, error.message, error.name]).toEqual([
        exit,
        code,
        code,
        "OperatorCliError",
      ]);
    }
    for (const exit of [130, 143] as const) {
      const error = new OperatorCliInterrupted(exit);
      expect([exitCodeFor(error), error.message, error.name]).toEqual([
        exit,
        "interrupted",
        "OperatorCliInterrupted",
      ]);
    }
  });

  it("maps accepted domain, configuration, policy and authoring error types", () => {
    const domain = [
      ["auth.invalid", 3],
      ["dashboard.forbidden", 3],
      ["invitation.unavailable", 4],
      ["request.conflict", 4],
      ["run.unavailable", 4],
    ] as const;
    for (const [code, exit] of domain) expect(exitCodeFor(new TeacherDomainError(code))).toBe(exit);
    const teaching = [
      ["invalid-request", 2],
      ["operator-unconfigured", 5],
      ["skill-unavailable", 5],
    ] as const;
    for (const [code, exit] of teaching)
      expect(exitCodeFor(new TeachingConfigurationError(code))).toBe(exit);
    const policy = [
      ["access-denied", 2],
      ["changed-file", 2],
      ["duplicate-class-id", 2],
      ["invalid-bound", 2],
      ["invalid-document", 2],
      ["invalid-path", 2],
      ["io-failure", 6],
      ["not-found", 2],
      ["not-regular-file", 2],
      ["symlink", 2],
      ["too-large", 2],
    ] as const;
    for (const [code, exit] of policy)
      expect(exitCodeFor(new OperatorConfigurationError(code, "private /path"))).toBe(exit);
    const authoring = [
      ["SKILL_EXISTS", 4],
      ["SKILL_MISSING", 4],
      ["STALE_SKILL_DIGEST", 4],
      ["UNSAFE_AUTHORING_INPUT", 2],
      ["AUTHORING_LIMIT", 2],
      ["AUTHORING_WRITE_FAILED", 6],
      ["AUTHORING_RECOVERY_FAILED", 6],
      ["ROOT_NOT_EXCLUSIVE", 5],
      ["UNSAFE_SYMLINK", 5],
    ] as const;
    for (const [code, exit] of authoring)
      expect(exitCodeFor(new SkillAuthoringError(code, "private", "private"))).toBe(exit);
  });

  it("maps schema, resource, core source and unknown failures by type only", () => {
    expect(exitCodeFor(z.string().safeParse(1).error)).toBe(2);
    expect(exitCodeFor(new GovernanceResourceError())).toBe(2);
    expect(exitCodeFor(new BundledSkillError("READ_FAILED", "private", "private"))).toBe(5);
    expect(exitCodeFor(new Error("private database failure"))).toBe(6);
    expect(exitCodeFor(Object.assign(new Error("invalid-input"), { code: "invalid-input" }))).toBe(
      6,
    );
    expect(exitCodeFor("request.conflict")).toBe(6);
    expect(exitCodeFor(null)).toBe(6);
  });

  it("uses fixed sanitized diagnostics per exit class", () => {
    expect([2, 3, 4, 5, 6, 130, 143].map((code) => diagnosticFor(code as never))).toEqual([
      "Invalid command or input.\n",
      "Installation is busy or its authority is unavailable.\n",
      "Operator command conflicts with the current state.\n",
      "Operator prerequisites are unavailable.\n",
      "Operator command failed or its outcome is uncertain.\n",
      "Operator command interrupted; verify its outcome.\n",
      "Operator command terminated; verify its outcome.\n",
    ]);
  });
});
