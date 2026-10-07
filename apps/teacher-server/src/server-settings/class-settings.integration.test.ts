import { SkillIdSchema } from "@marea/protocol";
import { findRepositorySkillRoot } from "../teaching/skills/repository-catalog.fixture.js";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ServerSettingsService } from "./service.boundary.js";
import { serverSettingsOperator } from "./operator.js";
import type { ServerSettings } from "./contracts.js";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import { createTeachingConfigurationModule } from "../teaching/configuration/dashboard-module.js";
import { BundledSkillSource } from "../teaching/skills/bundled-skill-source.boundary.js";
import {
  MemoryTeachingRepository,
  MemoryClassDirectory,
  teacher,
  readQuery,
  catalogQuery,
  revisionIds,
  saveRequest,
  teachingSettings,
  syntheticOperatorPolicy,
} from "../teaching/configuration/dashboard-module.fixture.js";
it("unlocks a fresh class after saving a server model and saves the bundled testing lesson", async () => {
  let current: ServerSettings = {
    version: 1,
    revision: 0,
    administrators: [teacher.userId],
    route: null,
    connections: {},
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
  };
  const store = {
    read: () => current,
    write: (next: ServerSettings) => {
      current = next;
    },
  };
  const server = new ServerSettingsService(store, inferenceProviderCatalog);
  const repository = new MemoryTeachingRepository();
  repository.grant(teacher.userId, "class:one");
  const source = new BundledSkillSource(
    findRepositorySkillRoot(fileURLToPath(new URL(".", import.meta.url))),
  );
  const service = createTeachingConfigurationModule({
    clock: { now: () => "2026-10-07T10:00:00.000Z" },
    ids: revisionIds(),
    repository,
    directory: new MemoryClassDirectory([{ classId: "class:one", displayName: "Class" }]),
    skills: { forTeacherClass: () => source },
    operator: serverSettingsOperator({ forClass: vi.fn().mockReturnValue(null) }, store),
  }).service;
  expect(await service.read(teacher, readQuery())).toMatchObject({ operatorReady: false });
  const lesson = await source.load(SkillIdSchema.parse("marea/testing"));
  if (!lesson) throw new Error("missing testing lesson");
  expect(lesson.criteria.map((criterion) => criterion.code)).toEqual(["RA5.c", "RA5.d", "RA5.e"]);
  const selected = teachingSettings("tutoring", [lesson], []);
  await expect(service.save(teacher, saveRequest(selected))).rejects.toMatchObject({
    code: "operator-unconfigured",
  });
  const route = {
    ...syntheticOperatorPolicy.route.providerRoute,
    providerId: "org.marea.openrouter",
    model: "synthetic/model",
  };
  await server.execute(
    teacher,
    new TextEncoder().encode(
      JSON.stringify({
        operation: "save",
        expectedRevision: 0,
        connections: { "org.marea.openrouter": { apiKey: "synthetic-unused-key" } },
        route,
        education: {},
        useCommonRoute: false,
      }),
    ),
  );
  expect(current.useCommonRoute).toBe(true);
  expect(await service.read(teacher, readQuery())).toMatchObject({ operatorReady: true });
  expect((await service.catalog(teacher, catalogQuery())).skills).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "marea/testing",
        kind: "didactic",
      }),
    ]),
  );
  await service.save(teacher, saveRequest(selected));
  expect(repository.configurationFor("class:one")?.providerRoute).toEqual(route);
  expect(repository.configurationFor("class:one")?.publicTemplate.didacticSkills).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "marea/testing" })]),
  );
});
