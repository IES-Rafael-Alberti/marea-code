import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_PROTOCOL_VERSION } from "@marea/protocol";
import type * as z from "zod";

import { TeacherDomainError } from "../../identity/errors.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { createTeacherProductHttp } from "../../product-http/teacher-product-http.boundary.js";
import {
  createServices,
  RecordingProvider,
  unavailableSkillAuthoring,
} from "../../product-http/product-http.fixture.js";
import { createTeachingConfigurationModule } from "../../teaching/configuration/dashboard-module.js";
import {
  CompositeSkillSource,
  DirectorySkillSource,
  BundledSkillSource,
  type SkillId,
  type SkillSource,
} from "../../teaching/skills/index.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";
import { SqliteTeachingDashboardRepository } from "./sqlite-teaching-dashboard-repository.js";
import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import {
  seedTeachingDatabase,
  servicesFor,
  student,
} from "../../../test-support/teaching-integration.fixture.js";

export const TEACHER_COOKIE = "marea_teacher_session=integration-teacher-token-000000";
export const STUDENT_COOKIE = "marea_teacher_session=integration-student-token-000000";

const teacher: AuthenticatedIdentity = {
  classId: null,
  displayName: "Integration teacher",
  role: "teacher",
  userId: "t1",
};

export function dashboardRequest(
  action: string,
  body: object,
  headers: Readonly<Record<string, string>> = {},
): Request {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    host: "teacher.test",
  });
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  return new Request(`https://teacher.test/api/v1/dashboard/teaching/${action}`, {
    body: JSON.stringify(body),
    headers: requestHeaders,
    method: "POST",
  });
}

export function envelope(kind: string, requestId: string) {
  return { kind, protocolVersion: CURRENT_PROTOCOL_VERSION, requestId };
}

async function writeSkill(root: string, kind: string, name: string, extra = ""): Promise<void> {
  await mkdir(join(root, kind, name, "resources"), { recursive: true });
  const content = `---\nname: ${name}\ndescription: Synthetic ${name} ${kind}\n---\n\nSynthetic ${name} instructions.\n`;
  await writeFile(join(root, kind, name, "SKILL.md"), `${content}${extra}`);
  await writeFile(join(root, kind, name, "resources", "guide.txt"), `Frozen ${name} guide.\n`);
}

export interface Harness {
  readonly app: ReturnType<typeof createTeacherProductHttp>;
  readonly database: NodeSqliteTestDatabase;
  readonly root: string;
  readonly skillIds: {
    didactic: string;
    evaluation: string;
    digests: { didactic: string; evaluation: string };
  };
}

export async function buildHarness(
  operatorConfigured = true,
  emptyCatalog = false,
): Promise<Harness> {
  const usagePolicy = {
    costUnit: "credit",
    inputCostUnitsPerToken: 1,
    maxConcurrentRequests: 1,
    maxCostUnits: 10_000,
    maxInputTokens: 2_000,
    maxOutputTokens: 2_000,
    maxRequests: 10,
    maxRequestDurationMs: 5_000,
    maxTokens: 4_000,
    maxToolCalls: 5,
    outputCostUnitsPerToken: 2,
    version: "usage:1",
  };
  const database = new NodeSqliteTestDatabase();
  seedTeachingDatabase(database);
  const root = await mkdtemp(join(tmpdir(), "teaching-dashboard-"));
  const bundledRoot = join(root, "bundled");
  const teacherRoot = join(root, "teacher");
  for (const directory of ["didactic", "evaluation"]) {
    await mkdir(join(bundledRoot, directory), { recursive: true });
    await mkdir(join(teacherRoot, directory), { recursive: true });
  }
  if (!emptyCatalog) {
    await writeSkill(teacherRoot, "didactic", "testing");
    await writeSkill(bundledRoot, "evaluation", "review");
  }
  const catalog: SkillSource = new CompositeSkillSource([
    new BundledSkillSource(bundledRoot),
    new DirectorySkillSource(teacherRoot, { source: "teacher", id: "t1" }),
  ]);
  const scoped: SkillSource = emptyCatalog
    ? catalog
    : {
        list: async (kind: "didactic" | "evaluation") => catalog.list(kind),
        load: (id: SkillId) => catalog.load(id),
      };
  const summaries = emptyCatalog ? [] : await catalog.list("didactic");
  const evaluationSummaries = emptyCatalog ? [] : await catalog.list("evaluation");
  const skills = {
    forTeacherClass: (teacherId: string, classId: string): SkillSource => {
      if (teacherId !== "t1" || classId !== "class:one") {
        throw new TeacherDomainError("dashboard.forbidden");
      }
      return scoped;
    },
  };
  const operator = {
    forClass: (classId: string) =>
      operatorConfigured && classId === "class:one"
        ? {
            route: {
              modelAlias: "marea" as const,
              providerRoute: {
                budget: {
                  evaluation: usagePolicy,
                  inputTokenCeiling: 1_000,
                  tutoring: usagePolicy,
                },
                model: "synthetic-model",
                providerId: "synthetic-provider",
              },
              version: "route:1",
            },
            teacherToolPolicy: {
              restrictions: [{ effect: "require-approval" as const, tool: "workspace.write" }],
              version: "policy:1",
            },
          }
        : null,
  };
  let revision = 0;
  const service = createTeachingConfigurationModule({
    clock: { now: () => "2026-09-08T09:00:00.000Z" },
    ids: { createId: (namespace) => `${namespace}:int-${String(++revision)}` },
    directory: new SqliteTeachingDashboardRepository(database),
    operator,
    repository: new SqliteTeachingConfigurationRepository(database),
    skills,
  }).service;
  const base = createServices(new RecordingProvider());
  const app = createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://dashboard.test"],
    serverVersion: "0.2.0",
    services: {
      ...base,
      skillAuthoring: unavailableSkillAuthoring,
      runs: servicesFor(database, catalog).runs,
      teachingConfiguration: service,
      identity: {
        ...base.identity,
        authenticate(token: string) {
          if (token === "integration-teacher-token-000000") {
            return { identity: teacher, principal: teacher };
          }
          if (token === "integration-student-token-000000") {
            return { identity: student, principal: student };
          }
          throw new TeacherDomainError("auth.invalid");
        },
      },
    },
  });
  const [didactic] = summaries;
  const [evaluation] = evaluationSummaries;
  return {
    app,
    database,
    root,
    skillIds: {
      didactic: didactic?.id ?? "teacher/t1/testing",
      digests: { didactic: didactic?.digest ?? "", evaluation: evaluation?.digest ?? "" },
      evaluation: evaluation?.id ?? "marea/review",
    },
  };
}

export function saveBody(
  harness: Harness,
  overrides: Record<string, unknown> = {},
  expectedVersion: string | null = null,
) {
  return {
    ...envelope("teaching-configuration-save", "request:save"),
    classId: "class:one",
    expectedVersion,
    settings: {
      agentMode: "tutoring",
      automaticEvaluation: false,
      classInstructions: { tutoring: "Tutoring instructions.", free: "Free instructions." },
      selection: {
        didactic: [{ digest: harness.skillIds.digests.didactic, id: harness.skillIds.didactic }],
        evaluation: [
          { digest: harness.skillIds.digests.evaluation, id: harness.skillIds.evaluation },
        ],
      },
    },
    ...overrides,
  };
}

export const authHeaders = { origin: "https://dashboard.test", cookie: TEACHER_COOKIE };

/** Strictly parses a protocol response so test access stays typed. */
export function parseEnvelope<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text));
}

export {
  newRun,
  servicesFor,
  student,
} from "../../../test-support/teaching-integration.fixture.js";
