import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TeacherDomainError } from "../identity/errors.js";
import { createTeacherProductHttp } from "./teacher-product-http.boundary.js";
import {
  createServices,
  RecordingProvider,
  teacher as fixtureTeacher,
} from "./product-http.fixture.js";
import { writeCoreSkill } from "../teaching/authoring-runtime/skill-authoring-service.fixture.js";
import { createProductSkillAuthoringService } from "../teaching/authoring-runtime/skill-authoring-service.js";
import { SkillAuthoringStore } from "../teaching/authoring/skill-authoring-store.boundary.js";
import { SkillAuthoringSource } from "../teaching/authoring/skill-authoring-source.boundary.js";
import { SqliteTeachingConfigurationRepository } from "../platform/persistence/sqlite-teaching-configuration-repository.js";
import {
  BundledSkillSource,
  CompositeSkillSource,
  DirectorySkillSource,
  type SkillSource,
} from "../teaching/skills/index.js";
import { NodeSqliteTestDatabase } from "../../test-support/node-sqlite-database.boundary.js";
import {
  seedTeachingDatabase,
  servicesFor as teachingServicesFor,
} from "../../test-support/teaching-integration.fixture.js";
import { teachingConfiguration } from "../../test-support/teaching-fixture.js";
import { SqliteRunSkillRepository } from "../platform/persistence/sqlite-run-skill-repository.js";
import { SqliteTeachingDashboardRepository } from "../platform/persistence/sqlite-teaching-dashboard-repository.js";
import { createTeachingConfigurationModule } from "../teaching/configuration/dashboard-module.js";

export const BASE = "https://teacher.test";
export const COOKIE = "marea_teacher_session=teacher-composition-token";
export const ORIGIN = "https://dashboard.test";

export async function buildComposition(
  options: { readonly revokeDuringPublication?: boolean } = {},
) {
  const database = new NodeSqliteTestDatabase();
  seedTeachingDatabase(database);
  const root = await mkdtemp(join(tmpdir(), "marea-teaching-http-composition-"));
  const bundledRoot = join(root, "bundled");
  const centerRoot = join(root, "center");
  const teacherRoot = join(root, "teacher");
  await writeCoreSkill(bundledRoot);
  await writeCoreSkill(centerRoot);
  const store = new SkillAuthoringStore(teacherRoot, { id: "t1", source: "teacher" });
  await store.initialize();
  const teacherSource = new SkillAuthoringSource(teacherRoot, { id: "t1", source: "teacher" });
  await teacherSource.initialize();
  const catalog: SkillSource = new CompositeSkillSource([
    new BundledSkillSource(bundledRoot),
    new DirectorySkillSource(centerRoot, { id: "center:one", source: "center" }),
    teacherSource,
  ]);
  const membershipRepository = new SqliteTeachingConfigurationRepository(database);
  const teachingServices = teachingServicesFor(database, catalog);
  const usagePolicy = {
    costUnit: "credit" as const,
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
    version: "usage:composition",
  };
  let teachingRevision = 0;
  const teachingConfigurationService = createTeachingConfigurationModule({
    clock: { now: () => "2026-09-10T08:00:00.000Z" },
    ids: { createId: (namespace) => `${namespace}:composition-${String(++teachingRevision)}` },
    directory: new SqliteTeachingDashboardRepository(database),
    operator: {
      forClass: (classId) =>
        classId === "class:one"
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
                version: "route:composition",
              },
              teacherToolPolicy: {
                restrictions: [{ effect: "require-approval" as const, tool: "workspace.write" }],
                version: "policy:composition",
              },
            }
          : null,
    },
    repository: membershipRepository,
    skills: { forTeacherClass: () => catalog },
  }).service;
  let membershipChecks = 0;
  const membership = {
    requireTeacherClass(teacherId: string, classId: string): void {
      membershipChecks += 1;
      if (options.revokeDuringPublication && membershipChecks === 2) {
        database.execute(
          "DELETE FROM marea_teacher_classes WHERE teacher_id = 't1' AND class_id = 'class:one'",
        );
      }
      membershipRepository.requireTeacherClass(teacherId, classId);
    },
  };
  const skillAuthoring = createProductSkillAuthoringService({
    membership,
    sourceForTeacherClass: (teacherId, classId) => {
      if (teacherId !== "t1" || classId !== "class:one")
        throw new TeacherDomainError("dashboard.forbidden");
      return catalog;
    },
    writerForTeacher: (teacherId) => {
      if (teacherId !== "t1") throw new TeacherDomainError("dashboard.forbidden");
      return store;
    },
  });
  const base = createServices(new RecordingProvider());
  const app = createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: [ORIGIN],
    serverVersion: "0.2.0",
    services: {
      ...base,
      teachingConfiguration: teachingConfigurationService,
      skillAuthoring,
      identity: {
        ...base.identity,
        authenticate(token) {
          if (token === "teacher-composition-token")
            return {
              identity: { ...fixtureTeacher, userId: "t1", classId: null },
              principal: fixtureTeacher,
            };
          if (token === "student-composition-token")
            return {
              identity: { ...fixtureTeacher, role: "student", userId: "s1" },
              principal: fixtureTeacher,
            };
          if (token === "other-teacher-composition-token")
            return {
              identity: { ...fixtureTeacher, userId: "t2" },
              principal: fixtureTeacher,
            };
          throw new TeacherDomainError("auth.invalid");
        },
      },
    },
  });
  const configuration = teachingConfiguration();
  membershipRepository.saveRevision({
    classId: "class:one",
    createdAt: "2026-09-10T08:00:00.000Z",
    configuration,
    expectedVersion: null,
    teacherId: "t1",
  });
  database.execute(
    "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, ?3, ?4)",
    [
      "snapshot:composition",
      JSON.stringify(configuration.publicTemplate),
      JSON.stringify(configuration.providerRoute),
      "2026-09-10T08:00:00.000Z",
    ],
  );
  database.execute(
    "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
    ["snapshot:composition", JSON.stringify(configuration.content)],
  );
  database.execute(
    "INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at) VALUES ('run:composition', 's1', 'class:one', 'snapshot:composition', 'client:composition', 'Composition proof', 'active', '2026-09-10T08:00:00.000Z', NULL)",
  );
  return {
    app,
    catalog,
    database,
    root,
    runSkills: new SqliteRunSkillRepository(database),
    store,
    teacherRoot,
    teachingServices,
  };
}

export function routeRequest(
  path: string,
  body: object,
  cookie = COOKIE,
  origin = ORIGIN,
): Request {
  return new Request(`${BASE}${path}`, {
    body: JSON.stringify(body),
    headers: { cookie, host: "teacher.test", origin, "content-type": "application/json" },
    method: "POST",
  });
}
