import { describe, expect, it, vi } from "vitest";

import type { TeachingOperatorPolicy } from "./dashboard-contracts.js";
import {
  catalogQuery,
  classesQuery,
  MemorySkillSource,
  MemoryTeachingRepository,
  MemoryClassDirectory,
  operatorConfiguration,
  policyWithoutBudget,
  readQuery,
  revisionIds,
  saveRequest,
  syntheticOperatorPolicy,
  syntheticSkill,
  teacher,
  teachingSettings,
} from "./dashboard-module.fixture.js";
import { Sha256DigestSchema, type RequestId } from "@marea/protocol";
import { TeachingConfigurationError, teachingConfigurationError } from "./dashboard-errors.js";
import { protocolError } from "../../product-http/response.js";
import { createTeachingConfigurationModule } from "./dashboard-module.js";
import type { TeachingConfigurationRepository } from "./contracts.js";
import { student } from "./dashboard-module.fixture.js";

const clock = { now: () => "2026-09-08T08:00:00.000Z" };

function defaultSettings(harness: ReturnType<typeof buildHarness>) {
  return teachingSettings("tutoring", [harness.didactic], [harness.evaluation]);
}

function buildHarness(
  overrides: {
    operator?: ReturnType<typeof operatorConfiguration>;
    source?: import("../skills/index.js").SkillSource;
  } = {},
) {
  const didactic = syntheticSkill("didactic", "testing");
  const evaluation = syntheticSkill("evaluation", "review");
  const repository = new MemoryTeachingRepository();
  repository.grant("t1", "class:one");
  const source = new MemorySkillSource([didactic, evaluation]);
  const service = createTeachingConfigurationModule({
    clock,
    ids: revisionIds(),
    directory: new MemoryClassDirectory([{ classId: "class:one", displayName: "One" }]),
    operator: overrides.operator ?? operatorConfiguration({ "class:one": syntheticOperatorPolicy }),
    repository,
    skills: { forTeacherClass: () => overrides.source ?? source },
  }).service;
  return { didactic, evaluation, repository, service, source };
}

describe("teaching module pagination and operator capture", () => {
  it("returns exactly one hundred classes without a continuation cursor", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      classId: `class:${String(index + 1).padStart(3, "0")}`,
      displayName: `Class ${String(index + 1)}`,
    }));
    const service = createTeachingConfigurationModule({
      clock,
      ids: revisionIds(),
      directory: new MemoryClassDirectory(rows),
      operator: operatorConfiguration({ "class:one": syntheticOperatorPolicy }),
      repository: new MemoryTeachingRepository(),
      skills: { forTeacherClass: () => new MemorySkillSource([]) },
    }).service;
    const page = await service.classes(teacher, classesQuery());
    expect(page.classes).toHaveLength(100);
    expect(page.nextAfterClassId).toBeNull();
  });
  it("traverses the full catalog with the exclusive keyset cursor", async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      syntheticSkill("didactic", `skill-${String(index + 1).padStart(3, "0")}`),
    );
    const harness = buildHarness({ source: new MemorySkillSource(many) });
    const first = await harness.service.catalog(teacher, catalogQuery());
    expect(first.skills.map((entry) => entry.id)).toEqual(
      many.slice(0, 100).map((bundle) => bundle.id),
    );
    expect(first.nextAfterSkillId).toBe("teacher/t1/skill-100");
    const second = await harness.service.catalog(teacher, catalogQuery(first.nextAfterSkillId));
    expect(second.skills.map((entry) => entry.id)).toEqual(["teacher/t1/skill-101"]);
    expect(second.nextAfterSkillId).toBeNull();
    const trailing = await harness.service.catalog(teacher, catalogQuery("teacher/t1/skill-101"));
    expect(trailing.skills).toEqual([]);
    expect(trailing.nextAfterSkillId).toBeNull();
    // A cursor between identities only ever produces later identities.
    const boundary = await harness.service.catalog(teacher, catalogQuery("teacher/t1/skill-100x"));
    expect(boundary.skills.map((entry) => entry.id)).toEqual(["teacher/t1/skill-101"]);
  });
  it("reports readiness only for a complete and valid operator policy", async () => {
    const missing = buildHarness({ operator: operatorConfiguration({}) });
    expect((await missing.service.read(teacher, readQuery())).operatorReady).toBe(false);
    const invalid = buildHarness({
      operator: operatorConfiguration({ "class:one": policyWithoutBudget() }),
    });
    expect((await invalid.service.read(teacher, readQuery())).operatorReady).toBe(false);
  });
  it("keeps caller edits from changing the captured operator policy", async () => {
    const mutablePolicy = JSON.parse(
      JSON.stringify(syntheticOperatorPolicy),
    ) as TeachingOperatorPolicy & {
      route: { providerRoute: { budget: { inputTokenCeiling: number } } };
      teacherToolPolicy: {
        restrictions: { effect: "deny" | "require-approval"; tool: string }[];
      };
    };
    const source = new MemorySkillSource([
      syntheticSkill("didactic", "testing"),
      syntheticSkill("evaluation", "review"),
    ]);
    const harness = buildHarness({
      operator: { forClass: () => mutablePolicy },
      source: {
        list: (kind) => source.list(kind),
        load: (id) => {
          // Mutate during materialization, after the policy capture.
          mutablePolicy.route.providerRoute.budget.inputTokenCeiling = 999;
          mutablePolicy.teacherToolPolicy.restrictions.push({
            effect: "deny",
            tool: "workspace.write",
          });
          return source.load(id);
        },
      },
    });
    await expect(
      harness.service.save(teacher, saveRequest(defaultSettings(harness))),
    ).resolves.toMatchObject({ configuration: { version: "revision:test-1" } });
    const stored = harness.repository.configurationFor("class:one");
    expect(stored?.providerRoute.budget).toBeDefined();
    expect(stored?.providerRoute.budget?.inputTokenCeiling).toBe(1_000);
    expect(stored?.publicTemplate.teacherToolPolicy.restrictions).toHaveLength(1);
  });
});

describe("teaching module service authorization", () => {
  it("rejects non-teachers before relying on repository membership checks", async () => {
    const permissive: TeachingConfigurationRepository = {
      loadForStudent: () => null,
      loadForTeacher: () => null,
      requireTeacherClass: () => {
        // Permissive: the service-level teacher check must fail first.
      },
      saveRevision: () => {
        throw new TeachingConfigurationError("invalid-request");
      },
    };
    const service = createTeachingConfigurationModule({
      clock,
      ids: revisionIds(),
      directory: new MemoryClassDirectory([]),
      operator: operatorConfiguration({ "class:one": syntheticOperatorPolicy }),
      repository: permissive,
      skills: { forTeacherClass: () => new MemorySkillSource([]) },
    }).service;
    const request = saveRequest(teachingSettings("tutoring", [], []));
    await expect(service.read(student, readQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    await expect(service.catalog(student, catalogQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    await expect(service.save(student, request)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    // Even a schema-invalid request must be rejected by authorization, not parsing.
    const valid = saveRequest(teachingSettings("tutoring", [], []));
    const invalid = { ...valid, settings: { ...valid.settings, automaticEvaluation: true } };
    await expect(service.save(student, invalid)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
  });
});

function grantedRepository() {
  const repository = new MemoryTeachingRepository();
  repository.grant("t1", "class:one");
  return repository;
}

describe("teaching module catalog ordering", () => {
  it("orders duplicate identities without reordering equal elements", async () => {
    const skill = syntheticSkill("didactic", "testing");
    const left = {
      ...syntheticSkill("didactic", "testing"),
      digest: Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`),
    };
    const summaries = [left, skill].map(
      ({ id, name, description, kind, source, digest, compatibility, criteria }) => ({
        id,
        name,
        description,
        kind,
        source,
        digest,
        license: null,
        compatibility,
        criteria,
      }),
    );
    const listings = vi.fn((kind: "didactic" | "evaluation") =>
      Promise.resolve(kind === "didactic" ? summaries : []),
    );
    const service = createTeachingConfigurationModule({
      clock,
      ids: revisionIds(),
      directory: new MemoryClassDirectory([]),
      operator: operatorConfiguration({ "class:one": syntheticOperatorPolicy }),
      repository: grantedRepository(),
      skills: { forTeacherClass: () => ({ list: listings, load: () => Promise.resolve(null) }) },
    }).service;
    const page = await service.catalog(teacher, catalogQuery());
    expect(page.skills.map((entry) => entry.digest)).toEqual([
      Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`),
      skill.digest,
    ]);
  });
});

describe("teaching configuration error mapping", () => {
  it("carries a diagnosable name and code in the private message", async () => {
    const error = new TeachingConfigurationError("skill-unavailable");
    expect(error.name).toBe("TeachingConfigurationError");
    expect(error.message).toContain("skill-unavailable");
    const mapped = teachingConfigurationError(error, "request:errors" as RequestId);
    expect(mapped.status).toBe(422);
    expect(await mapped.text()).toContain("request.invalid");
    expect(protocolError(500, "server.error", true).status).toBe(500);
  });
});
