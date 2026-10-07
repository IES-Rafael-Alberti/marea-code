import { emptyServerSettings } from "../../test-support/server-settings.fixture.js";
import { CanonicalRunEventSchema, type CanonicalRunEvent } from "@marea/protocol";
import { createObservabilityMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import type { SessionTrace, TelemetryExporterCatalogEntry } from "@marea/plugin-api";
import { setup, NOW } from "../../test-support/history-fixture.js";
import { teacher, clock } from "../../test-support/teaching-integration.fixture.js";
import type { ServerSettings, ServerSettingsStore } from "../server-settings/contracts.js";
import { ObservabilityRuntime } from "./runtime.js";
import { ObservabilitySettingsService } from "./settings.boundary.js";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

export const encode = (body: object) => new TextEncoder().encode(JSON.stringify(body));
export function addTraceEvent(
  database: SqliteApplicationDatabase,
  sequence: number,
  values: object,
  runId = "run:a",
) {
  const event = CanonicalRunEventSchema.parse({
    eventId: `event:${runId}:${String(sequence)}`,
    sequence,
    occurredAt: NOW,
    ...values,
  });
  database.execute(
    "INSERT INTO marea_run_events(event_id,run_id,sequence,occurred_at,event_type,payload_json) VALUES(?1,?2,?3,?4,?5,?6)",
    [event.eventId, runId, sequence, event.occurredAt, event.eventType, JSON.stringify(event)],
  );
  return event;
}
export function completeTurn(
  database: SqliteApplicationDatabase,
  offset = 3,
  runId = "run:a",
): readonly CanonicalRunEvent[] {
  return [
    addTraceEvent(
      database,
      offset,
      {
        eventType: "student-message",
        messageId: `message:${String(offset)}`,
        content: "Write a Python greeting",
      },
      runId,
    ),
    addTraceEvent(
      database,
      offset + 1,
      {
        eventType: "model-diagnostic",
        requestId: `request:${String(offset)}`,
        phase: "request",
        status: "started",
        content: '{"messages":[{"role":"user","content":"Write a Python greeting"}]}',
        truncated: false,
      },
      runId,
    ),
    addTraceEvent(
      database,
      offset + 2,
      {
        eventType: "model-diagnostic",
        requestId: `request:${String(offset)}`,
        phase: "response",
        status: "completed",
        content: "Use print('hello')",
        truncated: false,
      },
      runId,
    ),
    addTraceEvent(
      database,
      offset + 3,
      {
        eventType: "assistant-message",
        messageId: `message:${String(offset)}`,
        content: "Use print('hello')",
      },
      runId,
    ),
    addTraceEvent(
      database,
      offset + 4,
      { eventType: "turn-ended", messageId: `message:${String(offset)}`, state: "completed" },
      runId,
    ),
  ];
}
export function observabilityFixture(databasePath?: string) {
  const { database } = setup(databasePath);
  for (const migration of createObservabilityMigrationCatalog().slice(8))
    for (const sql of migration.statements) database.executeScript(sql);
  let now = NOW;
  let settings: ServerSettings = emptyServerSettings(teacher.userId);
  const store: ServerSettingsStore = {
    read: () => settings,
    write: (value, expected) => {
      if (settings.revision !== expected) throw new Error("conflict");
      settings = value;
    },
  };
  const traces: SessionTrace[] = [];
  let failure: Error | undefined;
  const entry: TelemetryExporterCatalogEntry = {
    manifest: {
      id: "org.marea.synthetic",
      kind: "telemetry-exporter",
      apiVersion: "1.0",
      implementationVersion: "0.1.0",
      entrypoint: "./src/index.ts",
      configurationVersion: 1,
      displayNameKey: "synthetic",
      descriptionKey: "synthetic",
      runtimeTargets: ["teacher-server"],
      capabilities: ["trace-export"],
      acceptedDataClassifications: ["student-content"],
      destination: "external",
      requiredDependencies: [],
      optionalDependencies: [],
      conflicts: [],
    },
    traces: {
      settings: {
        version: 1,
        name: { es: "Test", en: "Test", eu: "Test" },
        fields: [
          {
            key: "endpoint",
            kind: "url",
            required: true,
            defaultValue: "https://collector.test",
            label: { es: "URL", en: "URL", eu: "URL" },
          },
          {
            key: "secret",
            kind: "secret",
            required: true,
            label: { es: "Key", en: "Key", eu: "Key" },
          },
        ],
      },
      create(values) {
        if (values.endpoint === "invalid") throw new Error("private");
        return {
          export(trace, signal) {
            signal.throwIfAborted();
            if (failure) throw failure;
            traces.push(trace);
            return Promise.resolve();
          },
        };
      },
    },
  };
  const catalog = [entry];
  const runtime = new ObservabilityRuntime(
    database,
    store,
    catalog,
    { now: () => now },
    "synthetic-release",
    () => ["synthetic-key"],
  );
  const service = new ObservabilitySettingsService(
    store,
    catalog,
    runtime,
    clock,
    "synthetic-release",
  );
  const save = (body: object = {}) =>
    service.execute(
      teacher,
      encode({
        operation: "save",
        expectedRevision: settings.revision,
        pluginId: entry.manifest.id,
        values: { secret: "synthetic-key" },
        enabled: true,
        ...body,
      }),
    );
  return {
    database,
    store,
    runtime,
    service,
    save,
    catalog,
    traces,
    entry,
    fail: (error?: Error) => {
      failure = error;
    },
    now: (value: string) => {
      now = value;
    },
    teacher,
  };
}
