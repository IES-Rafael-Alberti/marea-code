import {
  OpenRunRequestSchema,
  SaveTeachingConfigurationResponseSchema,
  TeachingCatalogResponseSchema,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { CompositeSkillSource } from "../../teaching/skills/index.js";
import { fetchJson } from "../../product-http/product-http.fixture.js";
import {
  authHeaders,
  buildHarness,
  dashboardRequest,
  envelope,
  newRun,
  parseEnvelope,
  saveBody,
  servicesFor,
  student,
} from "./sqlite-teaching-dashboard-repository.fixture.js";
describe("teaching configuration snapshots over SQLite", () => {
  const harnessPromise = buildHarness();

  it("freezes the active run snapshot while a later run receives the new configuration", async () => {
    const harness = await harnessPromise;
    await harness.app.fetch(dashboardRequest("save", saveBody(harness), authHeaders));
    const runs = servicesFor(harness.database, new CompositeSkillSource([])).runs;
    const opened = runs.open(student, OpenRunRequestSchema.parse(newRun("before")));
    expect(opened.snapshot.prompt.version).toBe("revision:int-1");
    const update = await harness.app.fetch(
      dashboardRequest("save", saveBody(harness, {}, "revision:int-1"), authHeaders),
    );
    expect(update.status).toBe(200);
    expect(opened.snapshot.prompt.version).toBe("revision:int-1");
    expect(opened.snapshot.id).toBeDefined();
    const reopened = runs.open(student, OpenRunRequestSchema.parse(newRun("after")));
    expect(reopened.snapshot.prompt.version).toBe("revision:int-2");
  });
  it("keeps catalog empty and saves free mode without didactic content", async () => {
    const empty = await buildHarness(true, true);
    try {
      const catalog = await fetchJson(
        empty.app,
        dashboardRequest(
          "catalog",
          {
            ...envelope("teaching-catalog-query", "request:catalog"),
            afterSkillId: null,
            classId: "class:one",
          },
          authHeaders,
        ),
      );
      expect(parseEnvelope(TeachingCatalogResponseSchema, catalog.text).skills).toEqual([]);
      const free = await fetchJson(
        empty.app,
        dashboardRequest(
          "save",
          saveBody(empty, {
            settings: {
              agentMode: "free",
              automaticEvaluation: false,
              classInstructions: { tutoring: "a", free: "b" },
              selection: { didactic: [], evaluation: [] },
            },
          }),
          authHeaders,
        ),
      );
      expect(free.response.status).toBe(200);
      const stored = parseEnvelope(SaveTeachingConfigurationResponseSchema, free.text).configuration
        .settings;
      expect(stored.agentMode).toBe("free");
      expect(stored.selection.didactic).toEqual([]);
    } finally {
      empty.database.close();
      (await harnessPromise).database.close();
    }
  });
});
