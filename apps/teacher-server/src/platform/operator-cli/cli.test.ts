import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "./commands.js";
import { OperatorCliError } from "./errors.js";
import { cleanupInstallations } from "./filesystem.fixture.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  MAX_GOVERNANCE_REQUEST_BYTES,
  MAX_TEACHING_CONFIGURATION_BYTES,
  MAX_SKILL_RESPONSE_BYTES,
} from "@marea/protocol";
import type { GovernanceOperatorApplication } from "../../governance/operator-contracts.js";
import { parseArguments, runOperatorCli } from "./cli.js";
import { PasswordInput } from "./filesystem.fixture.js";
import { fixture, scope, target, account, expectedVersion, owner } from "./cli.fixture.js";
import {
  centerResult,
  associationResult,
  accountResult,
  classResult,
  memberResult,
  previewResult,
  skillResult,
  exchangeResult,
  CLI_NOW,
  CLI_DIGEST,
} from "./application.fixture.js";

afterEach(() => {
  cleanupInstallations();
  vi.restoreAllMocks();
});

const summarySkill = {
  id: skillResult.id,
  kind: skillResult.kind,
  source: skillResult.source,
  digest: skillResult.digest,
};
const safeAccount = {
  centerId: accountResult.centerId,
  userId: accountResult.userId,
  displayName: accountResult.displayName,
  role: accountResult.role,
  state: accountResult.state,
  version: accountResult.version,
};
const safeAdoption = {
  digest: CLI_DIGEST,
  classes: 2,
  accounts: 3,
  memberships: 4,
  missingClasses: 1,
  missingUsers: 2,
};
const safePreview = {
  previewId: previewResult.previewId,
  centerId: previewResult.centerId,
  classId: previewResult.classId,
  expectedTeachingVersion: previewResult.expectedTeachingVersion,
  expiresAt: previewResult.expiresAt,
  packageDigest: previewResult.packageDigest,
};

interface Row {
  name: string;
  method: keyof GovernanceOperatorApplication;
  payload: Record<string, unknown>;
  summary: unknown;
  flags?: "output" | "digest";
  extra?: Record<string, unknown>;
  bound?: number;
  artifact?: unknown;
}
const rows: readonly Row[] = [
  {
    name: "center create",
    method: "createCenter",
    payload: { ...scope, displayName: "New", expectedVersion: null },
    summary: centerResult,
  },
  {
    name: "center rename",
    method: "renameCenter",
    payload: { ...scope, displayName: "Renamed", expectedVersion },
    summary: centerResult,
  },
  {
    name: "account associate",
    method: "associateAccount",
    payload: { ...account, expectedVersion: null },
    summary: associationResult,
  },
  {
    name: "administrator grant",
    method: "setAdministrator",
    payload: { ...account, expectedVersion },
    extra: { capability: "administrator" },
    summary: associationResult,
  },
  {
    name: "administrator revoke",
    method: "setAdministrator",
    payload: { ...account, expectedVersion },
    extra: { capability: "member" },
    summary: associationResult,
  },
  {
    name: "account create",
    method: "createAccount",
    payload: {
      ...account,
      displayName: "Person",
      login: "synthetic",
      role: "teacher",
      classId: null,
      expectedVersion: null,
    },
    summary: safeAccount,
  },
  {
    name: "account rename",
    method: "renameAccount",
    payload: { ...account, displayName: "Renamed", expectedVersion },
    summary: safeAccount,
  },
  {
    name: "account state",
    method: "changeAccountState",
    payload: { ...account, state: "disabled", expectedVersion },
    summary: safeAccount,
  },
  {
    name: "class create",
    method: "createClass",
    payload: { ...target, displayName: "New", expectedVersion: null },
    summary: classResult,
  },
  {
    name: "class rename",
    method: "renameClass",
    payload: { ...target, displayName: "Renamed", expectedVersion },
    summary: classResult,
  },
  {
    name: "membership change",
    method: "changeMembership",
    payload: { ...target, userId: "user:test", state: "revoked", expectedVersion },
    summary: memberResult,
  },
  {
    name: "sessions revoke",
    method: "revokeSessions",
    payload: { ...account, expectedVersion },
    summary: { userId: "user:test", version: "revision:revoked", revokedAt: CLI_NOW },
  },
  {
    name: "adoption preview",
    method: "previewAdoption",
    payload: { map: { classes: [], accounts: [], administrators: [] } },
    summary: safeAdoption,
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "adoption confirm",
    method: "confirmAdoption",
    payload: { map: { classes: [], accounts: [], administrators: [] } },
    summary: safeAdoption,
    flags: "digest",
    extra: { digest: CLI_DIGEST },
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "class export",
    method: "exportClass",
    payload: { ...target, expectedTeachingVersion: expectedVersion },
    summary: { completed: true },
    flags: "output",
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
    artifact: exchangeResult,
  },
  {
    name: "class import-preview",
    method: "previewClassImport",
    payload: { ...target, expectedTeachingVersion: null, package: exchangeResult },
    summary: safePreview,
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "class import-confirm",
    method: "confirmClassImport",
    payload: { ...target, previewId: "preview:input" },
    summary: { classId: "class:test", teachingVersion: "revision:teaching" },
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "class import-cancel",
    method: "cancelClassImport",
    payload: { ...target, previewId: "preview:input" },
    summary: { previewId: "preview:test" },
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "policy validate",
    method: "validatePolicy",
    payload: { document: { version: 1, classes: [] } },
    summary: { classes: 3 },
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "policy publish",
    method: "publishPolicy",
    payload: { document: { version: 1, classes: [] } },
    summary: { classes: 3 },
    flags: "output",
    bound: MAX_TEACHING_CONFIGURATION_BYTES,
  },
  {
    name: "skill list",
    method: "listSkills",
    payload: { owner, kind: "didactic" },
    summary: { skills: [summarySkill] },
  },
  {
    name: "skill read",
    method: "readSkill",
    payload: { owner, skillId: skillResult.id },
    summary: { completed: true },
    flags: "output",
    artifact: skillResult,
  },
  {
    name: "skill validate",
    method: "validateSkill",
    payload: { owner, request: { kind: "didactic", slug: "example", files: [] } },
    summary: { ...summarySkill, files: 1 },
    bound: MAX_SKILL_RESPONSE_BYTES,
  },
  {
    name: "skill save",
    method: "saveSkill",
    payload: {
      owner,
      request: { kind: "didactic", slug: "example", files: [], expectedDigest: null },
    },
    summary: summarySkill,
    bound: MAX_SKILL_RESPONSE_BYTES,
  },
];

describe("complete typed command routing", () => {
  it("exposes precisely the 25 operator commands and no HTTP/maintenance entry", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [...rows.map((row) => row.name), "credential provision"].sort(),
    );
    expect(Object.isFrozen(COMMANDS)).toBe(true);
    expect(COMMANDS["credential provision"]?.keys).toEqual([]);
  });
  for (const row of rows)
    it(`${row.name}: exact payload, bounds, private context and summary`, async () => {
      const f = fixture();
      const flags =
        row.flags === undefined
          ? []
          : [`--${row.flags}`, row.flags === "output" ? f.output : CLI_DIGEST];
      expect(COMMANDS[row.name]?.inputBytes).toBe(row.bound ?? MAX_GOVERNANCE_REQUEST_BYTES);
      expect(COMMANDS[row.name]?.passwordStdin).toBe(false);
      expect(await runOperatorCli(f.argv(row.name, row.payload, flags), f.dependencies)).toBe(0);
      const method = f.application[row.method];
      expect(method).toHaveBeenCalledTimes(1);
      const received = method.mock.calls[0]?.[0];
      expect(received).toEqual({
        ...row.payload,
        ...row.extra,
        ...(row.name === "policy publish" ? { outputPath: f.output } : {}),
        authority: received?.authority,
        now: CLI_NOW,
        requestId: received?.requestId,
      });
      expect(received?.authority).toEqual({
        ...f.capability,
        assertOwned: received?.authority.assertOwned,
      });
      expect(received?.requestId).toMatch(/^request:cli-[0-9a-f-]{36}$/);
      const assertions = f.events.length;
      received?.authority.assertOwned();
      expect(f.events.slice(assertions)).toEqual(["assert"]);
      expect(f.dependencies.stdout.mock.calls).toEqual([[`${JSON.stringify(row.summary)}\n`]]);
      expect(f.dependencies.stderr).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.events.indexOf("release")).toBeGreaterThan(f.events.indexOf("close"));
      expect(f.events.indexOf("stdout")).toBeGreaterThan(f.events.indexOf("release"));
      expect(f.signals.eventNames()).toEqual([]);
      if (row.artifact !== undefined)
        expect(JSON.parse(readFileSync(f.output, "utf8"))).toEqual(row.artifact);
      else expect(existsSync(f.output)).toBe(false);
    });
  it("provisions only a private stdin/prompt password with exact IDs and a safe result", async () => {
    for (const tty of [false, true]) {
      const f = fixture();
      const stdin = new PasswordInput(tty);
      const result = runOperatorCli(
        [
          "--installation",
          f.root,
          "credential",
          "provision",
          "--user",
          "user:test",
          "--expected-version",
          expectedVersion,
          ...(tty ? [] : ["--password-stdin"]),
        ],
        { ...f.dependencies, stdin },
      );
      stdin.send("private-password\n");
      if (!tty) stdin.end();
      expect(await result).toBe(0);
      expect(f.application.provisionCredential.mock.calls[0]?.[0]).toMatchObject({
        userId: "user:test",
        expectedVersion,
        password: "private-password",
      });
      expect(f.dependencies.stdout.mock.calls).toEqual([
        ['{"userId":"user:test","version":"revision:credential"}\n'],
      ]);
      expect(f.dependencies.prompt.mock.calls).toEqual(tty ? [["Password: "], ["\n"]] : []);
    }
  });
  it("rejects a missing private skill without publishing a misleading null artifact", async () => {
    const f = fixture();
    f.application.readSkill.mockResolvedValue(null);
    expect(
      await runOperatorCli(
        f.argv("skill read", { owner, skillId: skillResult.id }, ["--output", f.output]),
        f.dependencies,
      ),
    ).toBe(5);
    expect(existsSync(f.output)).toBe(false);
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
  });
});

describe("strict arguments and JSON payload envelope", () => {
  it("rejects unknown, duplicate, missing, empty and command-inapplicable arguments before acquisition", async () => {
    const f = fixture();
    const base = f.argv();
    const invalid = [
      [],
      ["--installation"],
      ["--other", f.root, ...base.slice(2)],
      ["--installation", "", ...base.slice(2)],
      ["--installation", f.root, "unknown", "create"],
      base.slice(0, -2),
      base.slice(0, -1),
      [...base.slice(0, -1), ""],
      [...base.slice(0, -1), "--input"],
      [...base, "position"],
      [...base, "--input", f.input],
      [...base, "xxinput", f.input],
      [...base, "--unknown", "value"],
      [...base, "--password-stdin"],
      [...base, "--output", f.output],
      [
        "--installation",
        f.root,
        "credential",
        "provision",
        "--user",
        "user:test",
        "--expected-version",
        expectedVersion,
        "--password-stdin",
        "--password-stdin",
      ],
      [
        "--installation",
        f.root,
        "credential",
        "provision",
        "--user",
        "user:test",
        "--expected-version",
        expectedVersion,
        "--password",
        "secret",
      ],
    ];
    invalid.push(["--installation", f.root, "center", "create", "xxinput", f.input]);
    invalid.push(["--installation", f.root, "adoption", "confirm", "--input", f.input]);
    for (const argv of invalid) {
      expect(() => parseArguments(argv)).toThrow(new OperatorCliError("invalid-input"));
      expect(await runOperatorCli(argv, f.dependencies), JSON.stringify(argv)).toBe(2);
    }
    expect(f.dependencies.acquire).not.toHaveBeenCalled();
    expect(f.dependencies.compose).not.toHaveBeenCalled();
    expect(f.dependencies.stdout).not.toHaveBeenCalled();
    expect(f.signals.eventNames()).toEqual([]);
    expect(() => parseArguments(["--installation", f.root, "toString", "call"])).toThrow(
      "invalid-input",
    );
  });
  it("rejects spoofed authority, generated envelope keys and grant capability before domain work", async () => {
    const f = fixture();
    for (const key of [
      "authority",
      "now",
      "requestId",
      "protocolVersion",
      "kind",
      "unexpected",
      "__proto__",
    ]) {
      const argv = f.argv("center create", {
        centerId: "center:test",
        displayName: "Center",
        expectedVersion: null,
        [key]: "spoof",
      });
      expect(await runOperatorCli(argv, f.dependencies)).toBe(2);
    }
    expect(
      await runOperatorCli(
        f.argv("administrator grant", { ...account, expectedVersion, capability: "member" }),
        f.dependencies,
      ),
    ).toBe(2);
    expect(f.application.createCenter).not.toHaveBeenCalled();
    expect(f.application.setAdministrator).not.toHaveBeenCalled();
  });
  it("uses actual byte bounds before ports and validates credential arguments before reading stdin", async () => {
    const f = fixture();
    const argv = f.argv();
    writeFileSync(f.input, " ".repeat(MAX_GOVERNANCE_REQUEST_BYTES) + "{}");
    expect(await runOperatorCli(argv, f.dependencies)).toBe(2);
    expect(f.application.createCenter).not.toHaveBeenCalled();
    const creds = [
      "--installation",
      f.root,
      "credential",
      "provision",
      "--user",
      "",
      "--expected-version",
      expectedVersion,
      "--password-stdin",
    ];
    expect(await runOperatorCli(creds, f.dependencies)).toBe(2);
    creds[5] = "invalid id";
    expect(await runOperatorCli(creds, f.dependencies)).toBe(2);
    creds[5] = "user:test";
    creds[7] = "invalid version";
    expect(await runOperatorCli(creds, f.dependencies)).toBe(2);
    expect(f.application.provisionCredential).not.toHaveBeenCalled();
    expect(f.stdin.eventNames()).toEqual([]);
  });
});
