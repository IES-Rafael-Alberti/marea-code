import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CredentialLoginSchema, SafeDisplayNameSchema } from "@marea/protocol";
import { prepareState } from "./install.boundary.js";
import { previewVersion, serverOrigin } from "./preview-channel.js";
import { installExampleSkill } from "./preview-skills.boundary.js";

export const setupAnswers = z
  .object({
    center: SafeDisplayNameSchema,
    classroom: SafeDisplayNameSchema,
    teacher: SafeDisplayNameSchema,
    login: CredentialLoginSchema,
    origin: z.string().transform(serverOrigin),
    port: z.number().int().min(1024).max(65535),
    google: z
      .object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        domain: z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SetupAnswers = z.infer<typeof setupAnswers>;
export type RunPrivateCommand = (binary: string, args: readonly string[], input?: string) => string;

/** Scaffolds a new, private installation only. Never adopts or rewrites an existing installation. */
export function scaffoldServer(
  root: string,
  release: string,
  version: string,
  raw: SetupAnswers,
): void {
  const answers = setupAnswers.parse(raw);
  previewVersion.parse(version);
  prepareState(root);
  const path = (...parts: string[]) => join(root, ...parts);
  for (const directory of [
    "locks",
    "config",
    "state",
    "backups",
    "work",
    "core",
    "core/didactic",
    "core/evaluation",
    "core/evaluation/evaluate",
    "centers",
    "centers/main",
    "centers/main/didactic",
    "centers/main/evaluation",
    "teachers",
    "teachers/main",
    "teachers/main/didactic",
    "teachers/main/evaluation",
  ])
    mkdirSync(path(directory), { mode: 0o700 });
  const json = (name: string, value: object) => {
    writeFileSync(path(name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  };
  writeFileSync(
    path("core/evaluation/evaluate/SKILL.md"),
    "---\nname: evaluate\ndescription: Review learning evidence from the closed session\n---\n\nEvaluate the evidence against the teacher's criteria. Distinguish observations from inference.\n",
    { mode: 0o600 },
  );
  installExampleSkill(root, release);
  writeFileSync(path("state/digest.key"), randomBytes(32), { flag: "wx", mode: 0o600 });
  json("policy.json", { version: 1, classes: [] });
  json("config/operator-cli.json", {
    version: 1,
    databasePath: path("marea.sqlite"),
    operatorPolicyPath: path("policy.json"),
    coreSourcePath: path("core"),
    centers: [{ id: "center:main", root: path("centers/main") }],
    teachers: [{ id: "user:teacher", root: path("teachers/main") }],
    personalOwners: [{ classId: "class:main", teacherId: "user:teacher" }],
  });
  json("config/operations.json", {
    version: 1,
    databasePath: path("marea.sqlite"),
    indexPath: path("state/deletion-index.sqlite"),
    backupRoot: path("backups"),
    authorityLineage: `lineage:${randomUUID()}`,
    rootId: `root:${randomUUID()}`,
    databaseLineage: `sha256:${randomBytes(32).toString("hex")}`,
    releaseId: "release:preview",
    limits: { fileCount: 10000, fileBytes: 256_000_000, totalBytes: 1_000_000_000 },
    stateFiles: [],
  });
  const origin = new URL(answers.origin);
  if (answers.google !== undefined) json("state/google-workspace.json", answers.google);
  json("config/teacher-host.json", {
    version: 1,
    releaseId: "release:preview",
    listen: { hostname: "127.0.0.1", port: answers.port },
    allowedHosts: [origin.host],
    allowedOrigins: [origin.origin],
    secureDashboardCookie: origin.protocol === "https:",
    serverVersion: version,
    statusPath: path("state/host-status.json"),
    digestKeyPath: path("state/digest.key"),
    dashboardDistPath: join(release, "dashboard"),
    providers: [],
    identityProviders:
      answers.google === undefined
        ? []
        : [
            {
              pluginId: "org.marea.google-workspace",
              settingsPath: path("state/google-workspace.json"),
            },
          ],
    retry: { delayMs: 1000, maxDelayMs: 30000 },
    evaluationIntervalMs: 60000,
    shutdownDrainMs: 15000,
  });
}

/** Uses the public offline CLIs, including password hashing and deletion-authority initialization. */
export function provisionServer(
  root: string,
  release: string,
  answers: SetupAnswers,
  password: string,
  run: RunPrivateCommand,
): void {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const operations = join(release, `marea-operations${suffix}`);
  const admin = join(release, `marea-admin${suffix}`);
  const inputPath = join(root, "work", `setup-${randomUUID()}.json`);
  const call = (binary: string, command: string[], payload?: object) => {
    if (payload !== undefined) writeFileSync(inputPath, JSON.stringify(payload), { mode: 0o600 });
    return run(binary, [
      "--installation",
      root,
      ...command,
      ...(payload === undefined ? [] : ["--input", inputPath]),
    ]);
  };
  try {
    call(operations, ["installation", "initialize"]);
    call(operations, ["installation", "upgrade-profiles"], { name: "before-preview-setup" });
    call(admin, ["center", "create"], {
      centerId: "center:main",
      displayName: answers.center,
      expectedVersion: null,
    });
    const account = z.object({ version: z.string() }).parse(
      JSON.parse(
        call(admin, ["account", "create"], {
          centerId: "center:main",
          userId: "user:teacher",
          displayName: answers.teacher,
          login: answers.login,
          role: "teacher",
          classId: null,
          expectedVersion: null,
        }),
      ),
    );
    run(
      admin,
      [
        "--installation",
        root,
        "credential",
        "provision",
        "--user",
        "user:teacher",
        "--expected-version",
        account.version,
        "--password-stdin",
      ],
      `${password}\n`,
    );
    call(admin, ["administrator", "grant"], {
      centerId: "center:main",
      userId: "user:teacher",
      expectedVersion: account.version,
    });
    call(admin, ["class", "create"], {
      centerId: "center:main",
      classId: "class:main",
      displayName: answers.classroom,
      expectedVersion: null,
    });
    call(admin, ["membership", "change"], {
      centerId: "center:main",
      classId: "class:main",
      userId: "user:teacher",
      state: "active",
      expectedVersion: null,
    });
    call(operations, ["server-settings", "initialize"], {
      userId: "user:teacher",
      name: "before-server-settings",
    });
  } finally {
    rmSync(inputPath, { force: true });
  }
}
