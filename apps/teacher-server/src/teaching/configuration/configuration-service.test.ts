import { describe, expect, it, vi } from "vitest";

import {
  teachingConfiguration,
  teachingInput,
  teachingSkill,
} from "../../../test-support/teaching-fixture.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { SkillSource } from "../skills/index.js";
import { StoredTeachingConfigurationSchema } from "./configuration-schema.js";
import {
  ConfiguredTeachingRouteSchema,
  SaveClassTeachingSchema,
  TeachingConfigurationService,
} from "./configuration-service.js";
import { ConfigurationSnapshotSource } from "./configuration-snapshot-source.js";
import type { TeachingConfigurationRepository } from "./contracts.js";

const teacher: AuthenticatedIdentity = {
  userId: "t1",
  role: "teacher",
  classId: null,
  displayName: "Synthetic teacher",
};
const student: AuthenticatedIdentity = {
  userId: "s1",
  role: "student",
  classId: "class:one",
  displayName: "Synthetic student",
};

function fixture() {
  const configuration = teachingConfiguration();
  const repository = {
    requireTeacherClass: vi.fn<TeachingConfigurationRepository["requireTeacherClass"]>(),
    loadForTeacher: vi.fn<TeachingConfigurationRepository["loadForTeacher"]>(() => configuration),
    loadForStudent: vi.fn<TeachingConfigurationRepository["loadForStudent"]>(() =>
      StoredTeachingConfigurationSchema.parse(configuration),
    ),
    saveRevision: vi.fn<TeachingConfigurationRepository["saveRevision"]>(
      (input) => input.configuration,
    ),
  };
  const bundles = [teachingSkill("didactic"), teachingSkill("evaluation")];
  const source = {
    load: vi.fn<SkillSource["load"]>((id) =>
      Promise.resolve(bundles.find((bundle) => bundle.id === id) ?? null),
    ),
    list: vi.fn<SkillSource["list"]>(() => Promise.resolve([])),
  };
  const route = {
    version: "route:1",
    modelAlias: "marea" as const,
    providerRoute: { ...configuration.providerRoute },
  };
  const dependencies = {
    repository,
    clock: { now: () => "2026-09-07T12:00:00.000Z" },
    ids: { createId: vi.fn(() => "revision:1") },
    skills: { forTeacherClass: vi.fn(() => source) },
    routes: { forClass: vi.fn(() => route) },
  };
  return {
    configuration,
    repository,
    source,
    route,
    dependencies,
    service: new TeachingConfigurationService(dependencies),
  };
}

describe("teaching configuration service", () => {
  it.each(["tutoring", "free"] as const)(
    "saves a frozen %s revision using an operator-owned route",
    async (mode) => {
      const { repository, dependencies, service, source } = fixture();
      const input = teachingInput(mode);
      const result = await service.save(teacher, input);
      expect(result).toEqual(teachingConfiguration(mode));
      expect(repository.requireTeacherClass.mock.calls).toEqual([["t1", "class:one"]]);
      expect(dependencies.ids.createId).toHaveBeenCalledWith("revision");
      expect(dependencies.skills.forTeacherClass).toHaveBeenCalledWith("t1", "class:one");
      expect(dependencies.routes.forClass).toHaveBeenCalledWith("class:one");
      expect(source.load).toHaveBeenCalledTimes(mode === "free" ? 1 : 2);
      expect(repository.saveRevision.mock.calls).toEqual([
        [
          {
            classId: "class:one",
            teacherId: "t1",
            expectedVersion: null,
            createdAt: "2026-09-07T12:00:00.000Z",
            configuration: result,
          },
        ],
      ]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.content.automaticEvaluation).toBe(false);
    },
  );

  it("reads only through teacher scope and forwards an absent configuration", () => {
    const { repository, configuration, service } = fixture();
    expect(service.load(teacher, "class:one")).toBe(configuration);
    expect(repository.loadForTeacher.mock.calls).toEqual([["t1", "class:one"]]);
    repository.loadForTeacher.mockReturnValueOnce(null);
    expect(service.load(teacher, "class:one")).toBeNull();
    expect(() => service.load(student, "class:one")).toThrow("dashboard.forbidden");
    expect(repository.loadForTeacher).toHaveBeenCalledTimes(2);
  });

  it("rejects non-teachers and unauthorized classes before source access", async () => {
    const { service, repository, dependencies, source } = fixture();
    await expect(service.save(student, teachingInput())).rejects.toThrow("dashboard.forbidden");
    expect(repository.requireTeacherClass).not.toHaveBeenCalled();
    repository.requireTeacherClass.mockImplementation(() => {
      throw new Error("Class forbidden");
    });
    await expect(service.save(teacher, teachingInput())).rejects.toThrow("Class forbidden");
    expect(dependencies.routes.forClass).not.toHaveBeenCalled();
    expect(source.load).not.toHaveBeenCalled();
    expect(repository.saveRevision).not.toHaveBeenCalled();
  });

  it("forwards optimistic revision checks and never swallows conflicts or missing skills", async () => {
    const { service, repository, source } = fixture();
    repository.saveRevision.mockImplementationOnce(() => {
      throw new Error("Stale revision");
    });
    await expect(
      service.save(teacher, { ...teachingInput(), expectedVersion: "revision:old" }),
    ).rejects.toThrow("Stale revision");
    expect(repository.saveRevision.mock.calls[0]?.[0].expectedVersion).toBe("revision:old");
    source.load.mockResolvedValueOnce(null);
    await expect(service.save(teacher, teachingInput())).rejects.toMatchObject({
      reason: "missing",
    });
    expect(repository.saveRevision).toHaveBeenCalledTimes(1);
  });

  it("copies the request and route before asynchronous materialization", async () => {
    const { service, source, route } = fixture();
    const input = teachingInput();
    const instructions = { ...input.classInstructions };
    const selection = {
      didactic: [...input.selection.didactic],
      evaluation: [...input.selection.evaluation],
    };
    source.load.mockImplementationOnce(() => {
      instructions.tutoring = "Changed while reading";
      selection.didactic.splice(0);
      route.providerRoute.model = "changed-model";
      return Promise.resolve(teachingSkill("didactic"));
    });
    const result = await service.save(teacher, {
      ...input,
      classInstructions: instructions,
      selection,
    });
    expect(result).toEqual(teachingConfiguration());
  });

  it("persists explicit opt-in and rejects opt-in without an evaluation method", async () => {
    const { service, repository } = fixture();
    expect(
      (await service.save(teacher, { ...teachingInput(), automaticEvaluation: true })).content
        .automaticEvaluation,
    ).toBe(true);
    const input = teachingInput();
    await expect(
      service.save(teacher, {
        ...input,
        automaticEvaluation: true,
        selection: { ...input.selection, evaluation: [] },
      }),
    ).rejects.toThrow("Automatic evaluation requires a selected evaluation skill.");
    expect(repository.saveRevision).toHaveBeenCalledTimes(1);
  });

  it("strictly validates save requests and private configured routes", () => {
    const { route } = fixture();
    expect(
      SaveClassTeachingSchema.safeParse({ ...teachingInput(), providerRoute: route.providerRoute })
        .success,
    ).toBe(false);
    expect(ConfiguredTeachingRouteSchema.safeParse({ ...route, secret: "private" }).success).toBe(
      false,
    );
    const parsed = ConfiguredTeachingRouteSchema.parse(route);
    expect(parsed).toEqual(route);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});

describe("configuration-backed run snapshots", () => {
  it("keeps evaluation and upstream routing outside the public snapshot", () => {
    const { repository, configuration } = fixture();
    const result = new ConfigurationSnapshotSource(repository).capture("snapshot:new", student);
    expect(result.snapshot).toEqual({
      ...configuration.publicTemplate,
      id: "snapshot:new",
      startup: {
        version: configuration.content.startup?.version,
        content: configuration.content.startup?.content,
        digest: configuration.content.startup?.digest,
      },
    });
    expect(result.teaching).toEqual(configuration.content);
    expect(result.providerRoute).toEqual(configuration.providerRoute);
    expect(repository.loadForStudent.mock.calls).toEqual([[student]]);
    expect(Object.isFrozen(result)).toBe(true);
    const publicJson = JSON.stringify(result.snapshot);
    for (const privateText of [
      "providerId",
      "evaluationSkills",
      "automaticEvaluation",
      "Synthetic evaluation",
    ])
      expect(publicJson).not.toContain(privateText);
  });

  it("omits startup instructions from free snapshots", () => {
    const { repository } = fixture();
    repository.loadForStudent.mockReturnValue(teachingConfiguration("free"));
    const result = new ConfigurationSnapshotSource(repository).capture("snapshot:free", student);
    expect(result.snapshot).toEqual({
      ...teachingConfiguration("free").publicTemplate,
      id: "snapshot:free",
    });
    expect(result.snapshot).not.toHaveProperty("startup");
  });

  it("fails closed for missing configuration, invalid identities and invalid snapshot IDs", () => {
    const { repository } = fixture();
    const source = new ConfigurationSnapshotSource(repository);
    for (const identity of [
      teacher,
      { ...teacher, classId: student.classId },
      { ...student, classId: null },
    ])
      expect(() => source.capture("snapshot:new", identity)).toThrow("run.unavailable");
    expect(repository.loadForStudent).not.toHaveBeenCalled();
    repository.loadForStudent.mockReturnValueOnce(null);
    expect(() => source.capture("snapshot:new", student)).toThrow("run.unavailable");
    expect(() => source.capture("../invalid", student)).toThrow();
  });
});

it("freezes the selected writing gate and preserves it when an older editor omits the field", async () => {
  const f = fixture();
  const base = teachingInput("tutoring");
  for (const socraticMode of ["off", "normal", "strict"] as const) {
    const saved = await f.service.save(teacher, { ...base, socraticMode });
    expect(saved.publicTemplate.socraticMode).toBe(socraticMode);
    f.repository.loadForStudent.mockReturnValue(saved);
    const captured = new ConfigurationSnapshotSource(f.repository).capture(
      "snapshot:gate",
      student,
    );
    expect(captured.snapshot.socraticMode).toBe(socraticMode);
    f.repository.loadForTeacher.mockReturnValue(saved);
    expect((await f.service.save(teacher, base)).publicTemplate.socraticMode).toBe(socraticMode);
  }
  f.repository.loadForTeacher.mockReturnValue(null);
  expect((await f.service.save(teacher, base)).publicTemplate).not.toHaveProperty("socraticMode");
});
