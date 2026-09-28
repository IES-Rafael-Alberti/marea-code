import { vi } from "vitest";
import type { GovernanceOperatorApplication as Application } from "../../governance/operator-contracts.js";
import type { SkillBundle } from "../../teaching/skills/skill-source.js";
import {
  ClassExchangeSchema,
  ImportPreviewSchema,
  SkillIdSchema,
  Sha256DigestSchema,
} from "@marea/protocol";

export const CLI_NOW = "2026-09-12T10:00:00.000Z";
export const CLI_DIGEST = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
export const centerResult = {
  centerId: "center:test",
  displayName: "Center",
  version: "revision:center",
};
export const associationResult = {
  centerId: "center:test",
  userId: "user:test",
  capability: "member" as const,
  state: "active" as const,
  version: "revision:association",
};
export const accountResult = {
  centerId: "center:test",
  userId: "user:test",
  displayName: "Person",
  role: "teacher" as const,
  state: "pending" as const,
  version: "revision:account",
  canManageAccount: true,
};
export const classResult = {
  centerId: "center:test",
  classId: "class:test",
  displayName: "Class",
  operatorReady: false,
  version: "revision:class",
};
export const memberResult = {
  centerId: "center:test",
  classId: "class:test",
  userId: "user:test",
  role: "teacher" as const,
  state: "active" as const,
  version: "revision:member",
};
const adoptionResult = {
  digest: CLI_DIGEST,
  classes: 2,
  accounts: 3,
  memberships: 4,
  missingClassIds: ["class:missing"],
  missingUserIds: ["user:missing", "user:another"],
};
export const exchangeResult = ClassExchangeSchema.parse({
  format: "marea-class-exchange:1",
  source: { displayName: "Source" },
  agentMode: "free",
  classInstructions: { tutoring: "private tutoring", free: "private free" },
  selection: { didactic: [], evaluation: [] },
});
export const previewResult = ImportPreviewSchema.parse({
  previewId: "preview:test",
  centerId: "center:test",
  classId: "class:test",
  expectedTeachingVersion: null,
  expiresAt: "2026-09-12T10:10:00.000Z",
  packageDigest: CLI_DIGEST,
  settings: {
    agentMode: exchangeResult.agentMode,
    classInstructions: exchangeResult.classInstructions,
    selection: exchangeResult.selection,
    automaticEvaluation: false,
  },
  preservesDestinationEvaluationPolicy: true,
});
export const skillResult: SkillBundle = {
  id: SkillIdSchema.parse("teacher/user:test/example"),
  name: "private name",
  description: "private description",
  kind: "didactic",
  source: "teacher",
  digest: CLI_DIGEST,
  license: null,
  compatibility: null,
  criteria: [],
  files: [{ path: "SKILL.md", content: "private bytes", sizeBytes: 13 }],
};
const withPrivate = <T extends object>(value: T) => ({
  ...value,
  password: "must-not-leak",
  path: "/private/path",
  route: "private-provider",
});

export function applicationFixture() {
  return {
    createCenter: vi.fn<Application["createCenter"]>().mockResolvedValue(withPrivate(centerResult)),
    renameCenter: vi.fn<Application["renameCenter"]>().mockResolvedValue(withPrivate(centerResult)),
    associateAccount: vi
      .fn<Application["associateAccount"]>()
      .mockResolvedValue(withPrivate(associationResult)),
    setAdministrator: vi
      .fn<Application["setAdministrator"]>()
      .mockResolvedValue(withPrivate(associationResult)),
    provisionCredential: vi
      .fn<Application["provisionCredential"]>()
      .mockResolvedValue(withPrivate({ userId: "user:test", version: "revision:credential" })),
    createAccount: vi
      .fn<Application["createAccount"]>()
      .mockResolvedValue(withPrivate(accountResult)),
    renameAccount: vi
      .fn<Application["renameAccount"]>()
      .mockResolvedValue(withPrivate(accountResult)),
    changeAccountState: vi
      .fn<Application["changeAccountState"]>()
      .mockResolvedValue(withPrivate(accountResult)),
    createClass: vi.fn<Application["createClass"]>().mockResolvedValue(withPrivate(classResult)),
    renameClass: vi.fn<Application["renameClass"]>().mockResolvedValue(withPrivate(classResult)),
    changeMembership: vi
      .fn<Application["changeMembership"]>()
      .mockResolvedValue(withPrivate(memberResult)),
    revokeSessions: vi
      .fn<Application["revokeSessions"]>()
      .mockResolvedValue(
        withPrivate({ userId: "user:test", version: "revision:revoked", revokedAt: CLI_NOW }),
      ),
    previewAdoption: vi
      .fn<Application["previewAdoption"]>()
      .mockResolvedValue(withPrivate(adoptionResult)),
    confirmAdoption: vi
      .fn<Application["confirmAdoption"]>()
      .mockResolvedValue(withPrivate(adoptionResult)),
    exportClass: vi.fn<Application["exportClass"]>().mockResolvedValue(exchangeResult),
    previewClassImport: vi
      .fn<Application["previewClassImport"]>()
      .mockResolvedValue(withPrivate(previewResult)),
    confirmClassImport: vi
      .fn<Application["confirmClassImport"]>()
      .mockResolvedValue(
        withPrivate({ classId: "class:test", teachingVersion: "revision:teaching" }),
      ),
    cancelClassImport: vi
      .fn<Application["cancelClassImport"]>()
      .mockResolvedValue(withPrivate({ previewId: "preview:test" })),
    validatePolicy: vi
      .fn<Application["validatePolicy"]>()
      .mockResolvedValue(withPrivate({ classes: 3 })),
    publishPolicy: vi
      .fn<Application["publishPolicy"]>()
      .mockResolvedValue(withPrivate({ classes: 3 })),
    listSkills: vi.fn<Application["listSkills"]>().mockResolvedValue([skillResult]),
    readSkill: vi.fn<Application["readSkill"]>().mockResolvedValue(skillResult),
    validateSkill: vi
      .fn<Application["validateSkill"]>()
      .mockResolvedValue(withPrivate(skillResult)),
    saveSkill: vi.fn<Application["saveSkill"]>().mockResolvedValue(withPrivate(skillResult)),
  } satisfies Application;
}
