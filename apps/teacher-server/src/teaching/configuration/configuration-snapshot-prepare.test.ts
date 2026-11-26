import { expect, it, vi } from "vitest";
import { student } from "../../../test-support/teaching-integration.fixture.js";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import type { RunSnapshotCapture } from "../../sessions/contracts.js";
import { StoredTeachingConfigurationSchema } from "./configuration-schema.js";
import { ConfigurationSnapshotSource } from "./configuration-snapshot-source.js";
import type { TeachingConfigurationRepository } from "./contracts.js";

function repository() {
  return {
    requireTeacherClass: vi.fn<TeachingConfigurationRepository["requireTeacherClass"]>(),
    loadForTeacher: vi.fn<TeachingConfigurationRepository["loadForTeacher"]>(),
    loadForStudent: vi.fn<TeachingConfigurationRepository["loadForStudent"]>(() =>
      StoredTeachingConfigurationSchema.parse(teachingConfiguration()),
    ),
    saveRevision: vi.fn<TeachingConfigurationRepository["saveRevision"]>(),
  };
}

it("prepares the unadapted capture a new run would get, before any snapshot exists", async () => {
  const configurations = repository();
  const prepare = vi.fn((capture: RunSnapshotCapture) => {
    expect(capture.snapshot.id).toBe("snapshot:preparing");
    return Promise.resolve();
  });
  const adapt = vi.fn((capture: RunSnapshotCapture) => capture);
  const source = new ConfigurationSnapshotSource(configurations, adapt, prepare);
  await source.prepare(student);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ teaching: teachingConfiguration().content }),
    student,
  );
  expect(adapt).not.toHaveBeenCalled();
  expect(source.capture("snapshot:new", student).snapshot.id).toBe("snapshot:new");
  expect(adapt).toHaveBeenCalledOnce();
});

it("prepares nothing without a preparation step", async () => {
  const configurations = repository();
  await new ConfigurationSnapshotSource(configurations).prepare(student);
  expect(configurations.loadForStudent).not.toHaveBeenCalled();
});
