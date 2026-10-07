import { randomUUID } from "node:crypto";
import * as z from "zod";
import { type TelemetryExporterCatalogEntry, type SessionTraceExporter } from "@marea/plugin-api";
import type { AuthenticatedIdentity, Clock } from "../identity/contracts.js";
import { ServerSettingsError, type ServerSettingsStore } from "../server-settings/contracts.js";
import type { ObservabilityRuntime } from "./runtime.js";
import { connectionTestTrace } from "./test-trace.js";
import { deliverTrace } from "./delivery.js";
import {
  prepareTraceConnection,
  nextTraceConfiguration,
  projectTraceSettings,
} from "./settings-connections.js";

const Values = z.record(z.string().max(64), z.string().max(2048));
const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z.object({ operation: z.literal("retry") }).strict(),
  z
    .object({ operation: z.literal("test"), pluginId: z.string().min(1).max(128), values: Values })
    .strict(),
  z
    .object({
      operation: z.literal("save"),
      expectedRevision: z.number().int().nonnegative(),
      pluginId: z.string().min(1).max(128),
      values: Values,
      enabled: z.boolean(),
    })
    .strict(),
]);
function decodeInput(input: Uint8Array) {
  try {
    return Input.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)));
  } catch {
    throw new ServerSettingsError(400);
  }
}
export class ObservabilitySettingsService {
  constructor(
    readonly store: ServerSettingsStore,
    readonly catalog: readonly TelemetryExporterCatalogEntry[],
    readonly runtime: ObservabilityRuntime,
    readonly clock: Clock,
    readonly release: string,
  ) {}
  private authorize(identity: AuthenticatedIdentity) {
    const current = this.store.read();
    if (identity.role !== "teacher" || current?.administrators.includes(identity.userId) !== true)
      throw new ServerSettingsError(403);
    return current;
  }
  private async test(exporter: SessionTraceExporter, signal: AbortSignal) {
    try {
      await deliverTrace(exporter, connectionTestTrace(this.clock.now(), this.release), signal);
    } catch {
      throw new ServerSettingsError(502);
    }
    return { accepted: true };
  }
  async execute(
    identity: AuthenticatedIdentity,
    input: Uint8Array,
    signal = new AbortController().signal,
  ): Promise<object> {
    const current = this.authorize(identity);
    const q = decodeInput(input);
    const previous = current.observability;
    if (q.operation === "retry") this.runtime.queue.retry(this.clock.now());
    if (q.operation === "save" || q.operation === "test") {
      if (q.operation === "save" && q.expectedRevision !== current.revision)
        throw new ServerSettingsError(409);
      const entry = this.catalog.find((e) => e.manifest.id === q.pluginId)?.traces;
      if (entry === undefined) {
        // A removed destination can always be disabled without reading its secrets.
        if (
          q.operation !== "save" ||
          q.enabled ||
          previous?.pluginId !== q.pluginId ||
          Object.keys(q.values).length > 0
        )
          throw new ServerSettingsError(400);
        this.store.write(
          {
            ...current,
            revision: current.revision + 1,
            observability: { ...previous, enabled: false, epoch: randomUUID() },
          },
          current.revision,
        );
        this.runtime.changed();
      } else {
        const connection = prepareTraceConnection(
          entry,
          q.values,
          previous?.pluginId === q.pluginId ? previous : undefined,
        );
        const { exporter } = connection;
        if (q.operation === "test") return this.test(exporter, signal);
        this.store.write(
          {
            ...current,
            revision: current.revision + 1,
            observability: nextTraceConfiguration(q.pluginId, q.enabled, connection, previous),
          },
          current.revision,
        );
        this.runtime.changed();
      }
    }
    const next = this.store.read();
    if (next === null) throw new ServerSettingsError(503);
    return projectTraceSettings(next, this.catalog, this.runtime.status());
  }
}
