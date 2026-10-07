import {
  CURRENT_PROTOCOL_VERSION,
  Sha256DigestSchema,
  SkillIdSchema,
  type TeachingSettings,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type {
  ProductTeachingConfigurationService,
  TeachingOperatorPolicy,
} from "./dashboard-contracts.js";
import { TeachingConfigurationError } from "./dashboard-errors.js";
import {
  catalogQuery,
  classesQuery,
  MemoryClassDirectory,
  MemorySkillSource,
  MemoryTeachingRepository,
  operatorConfiguration,
  policyWithoutBudget,
  readQuery,
  revisionIds,
  saveRequest,
  student,
  syntheticOperatorPolicy,
  syntheticSkill,
  syntheticUsagePolicy,
  teacher,
  teachingSettings,
} from "./dashboard-module.fixture.js";
import { createTeachingConfigurationModule } from "./dashboard-module.js";
import type { SkillBundle, SkillSource } from "../skills/index.js";

const clock = { now: () => "2026-09-08T08:00:00.000Z" };

function rawSaveRequest(
  settings: TeachingSettings | TeachingSettings["selection"],
  expectedVersion: string | null = null,
) {
  return {
    classId: "class:one",
    expectedVersion,
    kind: "teaching-configuration-save" as const,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:save",
    settings,
  } as Parameters<ProductTeachingConfigurationService["save"]>[1];
}

function staleDigest() {
  return Sha256DigestSchema.parse(`sha256:${"0".repeat(64)}`);
}

function policyWithBudgetCeiling(ceiling: number): TeachingOperatorPolicy {
  return {
    route: {
      ...syntheticOperatorPolicy.route,
      providerRoute: {
        ...syntheticOperatorPolicy.route.providerRoute,
        budget: {
          inputTokenCeiling: ceiling,
          tutoring: syntheticUsagePolicy,
          evaluation: syntheticUsagePolicy,
        },
      },
    },
    teacherToolPolicy: syntheticOperatorPolicy.teacherToolPolicy,
  };
}

function policyWithDuplicateToolRules(): TeachingOperatorPolicy {
  return {
    route: syntheticOperatorPolicy.route,
    teacherToolPolicy: {
      restrictions: [
        { effect: "deny", tool: "workspace.write" },
        { effect: "require-approval", tool: "workspace.write" },
      ],
      version: "policy:1",
    },
  };
}

interface Harness {
  readonly createId: { createId: (namespace: "revision") => string };
  readonly didactic: SkillBundle;
  readonly evaluation: SkillBundle;
  readonly repository: MemoryTeachingRepository;
  readonly service: ProductTeachingConfigurationService;
  readonly skillsForTeacherClass: (teacherId: string, classId: string) => SkillSource;
  readonly source: MemorySkillSource;
}

function build(
  overrides: {
    directory?: MemoryClassDirectory;
    operator?: ReturnType<typeof operatorConfiguration>;
    source?: SkillSource;
    memberships?: boolean;
  } = {},
): Harness {
  const didactic = syntheticSkill("didactic", "testing");
  const evaluation = syntheticSkill("evaluation", "review");
  const source = new MemorySkillSource([didactic, evaluation]);
  const repository = new MemoryTeachingRepository();
  if (overrides.memberships ?? true) repository.grant("t1", "class:one");
  const directory =
    overrides.directory ?? new MemoryClassDirectory([{ classId: "class:one", displayName: "One" }]);
  const skillsForTeacherClass = vi.fn((): SkillSource => overrides.source ?? source);
  const createId = revisionIds();
  const service = createTeachingConfigurationModule({
    clock,
    ids: createId,
    directory,
    operator: overrides.operator ?? operatorConfiguration({ "class:one": syntheticOperatorPolicy }),
    repository,
    skills: { forTeacherClass: skillsForTeacherClass },
  }).service;
  return { createId, didactic, evaluation, repository, service, skillsForTeacherClass, source };
}

function defaultSettings(harness: Harness): TeachingSettings {
  return teachingSettings("tutoring", [harness.didactic], [harness.evaluation]);
}

describe("teaching configuration module", () => {
  it("rejects non-teachers and lists only authorized classes with binary keyset pages", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      classId: `class:${String(index + 1).padStart(3, "0")}`,
      displayName: `Class ${String(index + 1)}`,
    }));
    const harness = build({ directory: new MemoryClassDirectory(rows) });
    await expect(harness.service.classes(student, classesQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    const full = await harness.service.classes(teacher, classesQuery());
    expect(full.classes).toHaveLength(100);
    expect(full.nextAfterClassId).toBe("class:100");
    expect(full.classes[0]).toEqual({ classId: "class:001", displayName: "Class 1" });
    const small = build();
    const page = await small.service.classes(teacher, classesQuery());
    expect(page.classes).toEqual([{ classId: "class:one", displayName: "One" }]);
    expect(page.nextAfterClassId).toBeNull();
  });

  it("reads absent, ready and stored configuration without private fields", async () => {
    const harness = build();
    await expect(harness.service.read(student, readQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    const first = await harness.service.read(teacher, readQuery());
    expect(first.configuration).toBeNull();
    expect(first.operatorReady).toBe(true);
    const unconfigured = build({ operator: operatorConfiguration({}) });
    expect((await unconfigured.service.read(teacher, readQuery())).operatorReady).toBe(false);
    const saved = await harness.service.save(teacher, saveRequest(defaultSettings(harness)));
    const stored = await harness.service.read(teacher, readQuery());
    expect(stored.configuration).toStrictEqual({
      settings: {
        agentMode: "tutoring",
        automaticEvaluation: false,
        classInstructions: { tutoring: "Tutoring instructions.", free: "Free instructions." },
        selection: {
          didactic: [{ digest: harness.didactic.digest, id: harness.didactic.id }],
          evaluation: [{ digest: harness.evaluation.digest, id: harness.evaluation.id }],
        },
      },
      version: saved.configuration.version,
    });
    expect(JSON.stringify(stored)).not.toContain("providerRoute");
    expect(JSON.stringify(stored)).not.toContain("teacherToolPolicy");
    await expect(harness.service.read(teacher, readQuery("class:two"))).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
  });

  it("paginates the combined catalog and rechecks membership after async reads", async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      syntheticSkill("didactic", `skill-${String(index + 1).padStart(3, "0")}`),
    );
    const harness = build({ source: new MemorySkillSource(many) });
    await expect(harness.service.catalog(student, catalogQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    const page = await harness.service.catalog(teacher, catalogQuery());
    expect(page.skills).toHaveLength(100);
    expect(page.nextAfterSkillId).toBe("teacher/t1/skill-100");
    const sparse = build();
    const catalog = await sparse.service.catalog(teacher, catalogQuery());
    expect(catalog.skills.map((entry) => [entry.id, entry.kind])).toEqual([
      ["marea/review", "evaluation"],
      ["teacher/t1/testing", "didactic"],
    ]);
    expect(JSON.stringify(catalog)).not.toContain("license");
    expect(JSON.stringify(catalog)).not.toContain("criteria");
    expect(JSON.stringify(catalog)).not.toContain("files");
    const empty = build({ source: new MemorySkillSource([]) });
    expect((await empty.service.catalog(teacher, catalogQuery())).skills).toEqual([]);
    const unassigned = build({ memberships: false });
    await expect(unassigned.service.catalog(teacher, catalogQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    expect(unassigned.skillsForTeacherClass).not.toHaveBeenCalled();
    const revoked = build();
    revoked.source.beforeList = () => {
      revoked.repository.revoke("t1", "class:one");
      return Promise.resolve();
    };
    await expect(revoked.service.catalog(teacher, catalogQuery())).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
  });

  it("returns exactly one hundred catalog entries without a continuation cursor", async () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      syntheticSkill("didactic", `skill-${String(index + 1).padStart(3, "0")}`),
    );
    const harness = build({ source: new MemorySkillSource(many) });
    const page = await harness.service.catalog(teacher, catalogQuery());
    expect(page.skills).toHaveLength(100);
    expect(page.nextAfterSkillId).toBeNull();
  });

  it("blocks writes without membership before consulting operator or skill sources", async () => {
    const harness = build({ memberships: false });
    const forClass = vi.fn(() => syntheticOperatorPolicy);
    await expect(
      createTeachingConfigurationModule({
        clock,
        ids: revisionIds(),
        directory: new MemoryClassDirectory([]),
        operator: { forClass },
        repository: harness.repository,
        skills: { forTeacherClass: harness.skillsForTeacherClass },
      }).service.save(teacher, saveRequest(defaultSettings(harness))),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    expect(forClass).not.toHaveBeenCalled();
    expect(harness.skillsForTeacherClass).not.toHaveBeenCalled();
  });

  it("rejects invalid request settings with the sanitized invalid code", async () => {
    const harness = build();
    const rejection = harness.service.save(
      teacher,
      rawSaveRequest({
        ...defaultSettings(harness),
        automaticEvaluation: true,
        selection: { ...defaultSettings(harness).selection, evaluation: [] },
      }),
    );
    await expect(rejection).rejects.toBeInstanceOf(TeachingConfigurationError);
    await expect(rejection).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("blocks first creation and updates while operator prerequisites are absent or invalid", async () => {
    const harness = build({ operator: operatorConfiguration({}) });
    await expect(
      harness.service.save(teacher, saveRequest(defaultSettings(harness))),
    ).rejects.toMatchObject({ code: "operator-unconfigured" });
    expect(harness.skillsForTeacherClass).not.toHaveBeenCalled();
    const missingBudget = build({
      operator: operatorConfiguration({ "class:one": policyWithoutBudget() }),
    });
    const invalidBudget = build({
      operator: operatorConfiguration({ "class:one": policyWithBudgetCeiling(5_000) }),
    });
    await expect(
      missingBudget.service.save(teacher, saveRequest(defaultSettings(missingBudget))),
    ).rejects.toMatchObject({ code: "operator-unconfigured" });
    await expect(
      invalidBudget.service.save(teacher, saveRequest(defaultSettings(invalidBudget))),
    ).rejects.toMatchObject({ code: "operator-unconfigured" });
    const invalidPolicy = build({
      operator: operatorConfiguration({ "class:one": policyWithDuplicateToolRules() }),
    });
    await expect(
      invalidPolicy.service.save(teacher, saveRequest(defaultSettings(invalidPolicy))),
    ).rejects.toMatchObject({ code: "operator-unconfigured" });
  });

  it("verifies selected identities and digests including inactive didactics", async () => {
    const harness = build();
    const settings = defaultSettings(harness);
    await expect(
      harness.service.save(
        teacher,
        saveRequest({
          ...settings,
          selection: {
            ...settings.selection,
            didactic: [
              { id: SkillIdSchema.parse("teacher/t1/absent"), digest: harness.didactic.digest },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "skill-unavailable" });
    for (const agentMode of ["tutoring", "free"] as const) {
      await expect(
        harness.service.save(
          teacher,
          saveRequest({
            ...settings,
            agentMode,
            selection: {
              ...settings.selection,
              didactic: [{ id: harness.didactic.id, digest: staleDigest() }],
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "skill-unavailable" });
    }
    await expect(
      harness.service.save(
        teacher,
        saveRequest({ ...settings, selection: { ...settings.selection, evaluation: [] } }),
      ),
    ).resolves.toMatchObject({ configuration: { settings: { agentMode: "tutoring" } } });
  });

  it("saves tutoring and free configurations with the captured operator policy", async () => {
    const harness = build();
    const first = await harness.service.save(teacher, saveRequest(defaultSettings(harness)));
    expect(first.configuration.version).toBe("revision:test-1");
    const stored = harness.repository.configurationFor("class:one");
    expect(stored?.content.configurationVersion).toBe("revision:test-1");
    expect(stored?.publicTemplate.teacherToolPolicy).toEqual(
      syntheticOperatorPolicy.teacherToolPolicy,
    );
    expect(stored?.providerRoute).toEqual(syntheticOperatorPolicy.route.providerRoute);
    expect(stored?.providerRoute).not.toBe(syntheticOperatorPolicy.route.providerRoute);
    expect(stored?.publicTemplate.teacherToolPolicy).not.toBe(
      syntheticOperatorPolicy.teacherToolPolicy,
    );
    expect(harness.createId.createId).toHaveBeenCalledWith("revision");
    // Free mode keeps the didactic selection verified but omits didactic content.
    const free = await harness.service.save(
      teacher,
      saveRequest({ ...defaultSettings(harness), agentMode: "free" }, "revision:test-1"),
    );
    expect(free.configuration.settings.agentMode).toBe("free");
    expect(harness.repository.configurationFor("class:one")?.content.didacticSkills).toEqual([]);
  });

  it("enables automatic evaluation only with one selected evaluation skill", async () => {
    const harness = build();
    const enabled = await harness.service.save(
      teacher,
      saveRequest({ ...defaultSettings(harness), automaticEvaluation: true }),
    );
    expect(enabled.configuration.settings.automaticEvaluation).toBe(true);
    expect(harness.repository.configurationFor("class:one")?.content.automaticEvaluation).toBe(
      true,
    );
  });

  it("maps catalog drift between verification and materialization to 422", async () => {
    const didactic = syntheticSkill("didactic", "testing");
    const evaluation = syntheticSkill("evaluation", "review");
    const base = new MemorySkillSource([didactic, evaluation]);
    const harness = build({
      source: {
        list: (kind) => base.list(kind),
        load: (id) =>
          base.load(id).then((bundle) =>
            bundle === null
              ? null
              : {
                  ...bundle,
                  files: [
                    ...bundle.files,
                    { content: "Late edit", path: "resources/late.txt", sizeBytes: 9 },
                  ],
                },
          ),
      },
    });
    await expect(
      harness.service.save(teacher, saveRequest(defaultSettings(harness))),
    ).rejects.toMatchObject({ code: "skill-unavailable" });
  });

  it("keeps optimistic conflicts detectable and never retries a lost write", async () => {
    const harness = build();
    const settings = defaultSettings(harness);
    await harness.service.save(teacher, saveRequest(settings));
    await expect(
      harness.service.save(teacher, saveRequest(settings, "revision:test-1")),
    ).resolves.toMatchObject({ configuration: { version: "revision:test-2" } });
    await expect(
      harness.service.save(teacher, saveRequest(settings, "revision:test-1")),
    ).rejects.toMatchObject({ code: "request.conflict" });
    const [first, second] = await Promise.allSettled([
      harness.service.save(teacher, saveRequest(settings, "revision:test-2")),
      harness.service.save(teacher, saveRequest(settings, "revision:test-2")),
    ]);
    expect(first).toMatchObject({ status: "fulfilled" });
    expect(second).toMatchObject({
      reason: { code: "request.conflict" },
      status: "rejected",
    });
  });

  it("uses the operator budget from the injected policy without defaults", async () => {
    const harness = build({
      operator: operatorConfiguration({ "class:one": policyWithBudgetCeiling(500) }),
    });
    await expect(
      harness.service.save(teacher, saveRequest(defaultSettings(harness))),
    ).resolves.toMatchObject({ configuration: { version: "revision:test-1" } });
    expect(
      harness.repository.configurationFor("class:one")?.providerRoute.budget?.inputTokenCeiling,
    ).toBe(500);
  });
});

it("reads the saved writing gate and keeps it when a baseline editor saves other teaching settings", async () => {
  const f = build();
  const settings = { ...defaultSettings(f), socraticMode: "normal" as const };
  const first = await f.service.save(teacher, rawSaveRequest(settings));
  expect(first.configuration.settings.socraticMode).toBe("normal");
  expect((await f.service.read(teacher, readQuery())).configuration?.settings.socraticMode).toBe(
    "normal",
  );
  const second = await f.service.save(
    teacher,
    rawSaveRequest(defaultSettings(f), first.configuration.version),
  );
  expect(second.configuration.settings.socraticMode).toBe("normal");
});
