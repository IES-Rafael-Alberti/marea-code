import * as P from "@marea/protocol";
import type { OperatorContext } from "../../governance/authority.js";
import type { AdoptionReceipt } from "../../governance/adoption-contracts.js";
import type { OperatorCenterAssociation } from "../../governance/contracts.js";
import type { GovernanceOperatorApplication as Application } from "../../governance/operator-contracts.js";
import type { SkillSummary } from "../../teaching/skills/skill-source.js";
import { OperatorCliError } from "./errors.js";
import type { JsonObject } from "./input.js";

export type ValueFlag = "input" | "output" | "digest" | "user" | "expected-version";
export type Summary = Readonly<Record<string, unknown>>;

export interface CommandRequest {
  readonly context: OperatorContext;
  readonly payload: JsonObject;
  readonly flags: Readonly<Partial<Record<ValueFlag, string>>>;
  readonly password: () => Promise<string>;
}
/** A private artifact is written only to the explicit `--output`; stdout receives the summary. */
interface CommandOutcome {
  readonly summary: Summary;
  readonly artifact?: { readonly value: unknown; readonly maxBytes: number };
}
export interface CommandSpec<A = Application> {
  readonly flags: readonly ValueFlag[];
  readonly passwordStdin: boolean;
  readonly keys: readonly string[];
  readonly inputBytes: number;
  readonly run: (application: A, request: CommandRequest) => Promise<CommandOutcome>;
}

const ORDINARY_BYTES = P.MAX_GOVERNANCE_REQUEST_BYTES;
const MODULE_BYTES = P.MAX_TEACHING_CONFIGURATION_BYTES;

/** Strict private context is applied last; the JSON keys were already restricted to `keys`. */
function call<K extends keyof Application>(
  application: Application,
  method: K,
  request: CommandRequest,
  extra: object = {},
): ReturnType<Application[K]> {
  // These accepted boundary methods parse the untrusted payload before domain work.
  const port = application[method] as (
    input: Parameters<Application[K]>[0],
  ) => ReturnType<Application[K]>;
  const input = { ...request.payload, ...extra, ...request.context } as Parameters<
    Application[K]
  >[0];
  return port.call(application, input);
}
function summary<T>(project: (value: T) => Summary) {
  return (value: T): CommandOutcome => ({ summary: project(value) });
}
export function command<A = Application>(
  keys: readonly string[],
  run: CommandSpec<A>["run"],
  options: Partial<Pick<CommandSpec<A>, "flags" | "inputBytes">> = {},
): CommandSpec<A> {
  return {
    flags: options.flags ?? ["input"],
    passwordStdin: false,
    keys,
    inputBytes: options.inputBytes ?? ORDINARY_BYTES,
    run,
  };
}

const center = summary((value: P.Center) => ({
  centerId: value.centerId,
  displayName: value.displayName,
  version: value.version,
}));
const association = summary((value: OperatorCenterAssociation) => ({
  centerId: value.centerId,
  userId: value.userId,
  capability: value.capability,
  state: value.state,
  version: value.version,
}));
const account = summary((value: P.GovernanceAccount) => ({
  centerId: value.centerId,
  userId: value.userId,
  displayName: value.displayName,
  role: value.role,
  state: value.state,
  version: value.version,
}));
const classroom = summary((value: P.GovernanceClass) => ({
  centerId: value.centerId,
  classId: value.classId,
  displayName: value.displayName,
  operatorReady: value.operatorReady,
  version: value.version,
}));
const adoption = summary((value: AdoptionReceipt) => ({
  digest: value.digest,
  classes: value.classes,
  accounts: value.accounts,
  memberships: value.memberships,
  missingClasses: value.missingClassIds.length,
  missingUsers: value.missingUserIds.length,
}));
const policy = summary((value: { readonly classes: number }) => ({ classes: value.classes }));
const skill = (value: SkillSummary) => ({
  id: value.id,
  kind: value.kind,
  source: value.source,
  digest: value.digest,
});

const CENTER = ["centerId", "displayName", "expectedVersion"];
const ASSOCIATION = ["centerId", "userId", "expectedVersion"];
const CLASS = ["centerId", "classId", "displayName", "expectedVersion"];
const IMPORT = ["centerId", "classId", "previewId"];
const OWNER_REQUEST = ["owner", "request"];
const SKILL_BYTES = { inputBytes: P.MAX_SKILL_RESPONSE_BYTES };

export const COMMANDS: Readonly<Record<string, CommandSpec>> = Object.freeze({
  "center create": command(CENTER, (app, r) => call(app, "createCenter", r).then(center)),
  "center rename": command(CENTER, (app, r) => call(app, "renameCenter", r).then(center)),
  "account associate": command(ASSOCIATION, (app, r) =>
    call(app, "associateAccount", r).then(association),
  ),
  "administrator grant": command(ASSOCIATION, (app, r) =>
    call(app, "setAdministrator", r, { capability: "administrator" }).then(association),
  ),
  "administrator revoke": command(ASSOCIATION, (app, r) =>
    call(app, "setAdministrator", r, { capability: "member" }).then(association),
  ),
  "credential provision": {
    flags: ["user", "expected-version"],
    passwordStdin: true,
    keys: [],
    inputBytes: ORDINARY_BYTES,
    run: async (app, r) => {
      const userId = P.RevisionIdSchema.parse(r.flags.user);
      const expectedVersion = P.RevisionIdSchema.parse(r.flags["expected-version"]);
      const password = await r.password();
      const result = await app.provisionCredential({
        ...r.context,
        userId,
        expectedVersion,
        password,
      });
      return { summary: { userId: result.userId, version: result.version } };
    },
  },
  "account create": command(
    ["centerId", "userId", "displayName", "login", "role", "classId", "expectedVersion"],
    (app, r) => call(app, "createAccount", r).then(account),
  ),
  "account rename": command(["centerId", "userId", "displayName", "expectedVersion"], (app, r) =>
    call(app, "renameAccount", r).then(account),
  ),
  "account state": command(["centerId", "userId", "state", "expectedVersion"], (app, r) =>
    call(app, "changeAccountState", r).then(account),
  ),
  "class create": command(CLASS, (app, r) => call(app, "createClass", r).then(classroom)),
  "class rename": command(CLASS, (app, r) => call(app, "renameClass", r).then(classroom)),
  "membership change": command(
    ["centerId", "classId", "userId", "state", "expectedVersion"],
    (app, r) =>
      call(app, "changeMembership", r).then(
        summary((value: P.Membership) => ({
          centerId: value.centerId,
          classId: value.classId,
          userId: value.userId,
          role: value.role,
          state: value.state,
          version: value.version,
        })),
      ),
  ),
  "sessions revoke": command(["centerId", "userId", "expectedVersion"], (app, r) =>
    call(app, "revokeSessions", r).then(
      summary((value: P.Revocation) => ({
        userId: value.userId,
        version: value.version,
        revokedAt: value.revokedAt,
      })),
    ),
  ),
  "adoption preview": command(["map"], (app, r) => call(app, "previewAdoption", r).then(adoption), {
    inputBytes: MODULE_BYTES,
  }),
  "adoption confirm": command(
    ["map"],
    (app, r) => call(app, "confirmAdoption", r, { digest: r.flags.digest }).then(adoption),
    { flags: ["input", "digest"], inputBytes: MODULE_BYTES },
  ),
  "class export": command(
    ["centerId", "classId", "expectedTeachingVersion"],
    async (app, r) => ({
      summary: { completed: true },
      artifact: { value: await call(app, "exportClass", r), maxBytes: MODULE_BYTES },
    }),
    { flags: ["input", "output"], inputBytes: MODULE_BYTES },
  ),
  "class import-preview": command(
    ["centerId", "classId", "expectedTeachingVersion", "package"],
    (app, r) =>
      call(app, "previewClassImport", r).then(
        summary((value: P.ImportPreview) => ({
          previewId: value.previewId,
          centerId: value.centerId,
          classId: value.classId,
          expectedTeachingVersion: value.expectedTeachingVersion,
          expiresAt: value.expiresAt,
          packageDigest: value.packageDigest,
        })),
      ),
    { inputBytes: MODULE_BYTES },
  ),
  "class import-confirm": command(
    IMPORT,
    (app, r) =>
      call(app, "confirmClassImport", r).then(
        summary((value) => ({ classId: value.classId, teachingVersion: value.teachingVersion })),
      ),
    { inputBytes: MODULE_BYTES },
  ),
  "class import-cancel": command(
    IMPORT,
    (app, r) =>
      call(app, "cancelClassImport", r).then(summary((value) => ({ previewId: value.previewId }))),
    { inputBytes: MODULE_BYTES },
  ),
  "policy validate": command(
    ["document"],
    (app, r) => call(app, "validatePolicy", r).then(policy),
    { inputBytes: MODULE_BYTES },
  ),
  "policy publish": command(
    ["document"],
    (app, r) => call(app, "publishPolicy", r, { outputPath: r.flags.output }).then(policy),
    { flags: ["input", "output"], inputBytes: MODULE_BYTES },
  ),
  "skill list": command(["owner", "kind"], (app, r) =>
    call(app, "listSkills", r).then(summary((value) => ({ skills: value.map(skill) }))),
  ),
  "skill read": command(
    ["owner", "skillId"],
    async (app, r) => {
      const bundle = await call(app, "readSkill", r);
      if (bundle === null) throw new OperatorCliError("prerequisite-unavailable");
      return {
        summary: { completed: true },
        artifact: { value: bundle, maxBytes: P.MAX_SKILL_RESPONSE_BYTES },
      };
    },
    { flags: ["input", "output"] },
  ),
  "skill validate": command(
    OWNER_REQUEST,
    (app, r) =>
      call(app, "validateSkill", r).then(
        summary((value) => ({ ...skill(value), files: value.files.length })),
      ),
    SKILL_BYTES,
  ),
  "skill save": command(
    OWNER_REQUEST,
    (app, r) => call(app, "saveSkill", r).then(summary(skill)),
    SKILL_BYTES,
  ),
});
