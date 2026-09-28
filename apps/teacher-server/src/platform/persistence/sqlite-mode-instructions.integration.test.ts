import {
  OpenRunRequestSchema,
  SaveTeachingConfigurationResponseSchema,
  TeachingConfigurationResponseSchema,
  TUTORING_INSTRUCTIONS,
} from "@marea/protocol";
import { expect, it } from "vitest";
import { CompositeSkillSource } from "../../teaching/skills/index.js";
import {
  authHeaders,
  buildHarness,
  dashboardRequest,
  envelope,
  newRun,
  saveBody,
  servicesFor,
  student,
} from "./sqlite-teaching-dashboard-repository.fixture.js";

it("round-trips complete mode instructions through HTTP and SQLite without changing an open run", async () => {
  const harness = await buildHarness();
  try {
    const initial = await harness.app.fetch(
      dashboardRequest("save", saveBody(harness), authHeaders),
    );
    expect(initial.status).toBe(200);
    const first = SaveTeachingConfigurationResponseSchema.parse(await initial.json());
    const runs = servicesFor(harness.database, new CompositeSkillSource([])).runs;
    const before = runs.open(student, OpenRunRequestSchema.parse(newRun("original-mode")));
    const frozen = JSON.stringify(before.snapshot);
    expect(before.snapshot.prompt.content).toContain(TUTORING_INSTRUCTIONS);
    const classInstructions = {
      format: "complete-mode",
      tutoring: "Teach only the exercise selected by this teacher.",
      free: "Implement only the requested project.",
    };
    const updated = await harness.app.fetch(
      dashboardRequest(
        "save",
        saveBody(
          harness,
          {
            settings: { ...first.configuration.settings, classInstructions },
          },
          first.configuration.version,
        ),
        authHeaders,
      ),
    );
    expect(updated.status).toBe(200);
    const saved = SaveTeachingConfigurationResponseSchema.parse(await updated.json());
    expect(saved.configuration.settings.classInstructions).toEqual(classInstructions);
    const read = await harness.app.fetch(
      dashboardRequest(
        "read",
        {
          ...envelope("teaching-configuration-query", "request:complete-read"),
          classId: "class:one",
        },
        authHeaders,
      ),
    );
    expect(read.status).toBe(200);
    expect(
      TeachingConfigurationResponseSchema.parse(await read.json()).configuration?.settings
        .classInstructions,
    ).toEqual(classInstructions);
    const after = runs.open(student, OpenRunRequestSchema.parse(newRun("custom-mode")));
    expect(after.snapshot.prompt.content).toContain(classInstructions.tutoring);
    expect(after.snapshot.prompt.content).not.toContain(TUTORING_INSTRUCTIONS);
    expect(after.snapshot.prompt.content).not.toContain(classInstructions.free);
    expect(after.snapshot.prompt.content).toContain(
      "Las autorizaciones las decide Marea fuera del modelo",
    );
    expect(JSON.stringify(before.snapshot)).toBe(frozen);
    expect(after.snapshot.prompt.digest).not.toBe(before.snapshot.prompt.digest);
  } finally {
    harness.database.close();
  }
});
