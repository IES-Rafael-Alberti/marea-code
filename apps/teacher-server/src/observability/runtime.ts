import { TelemetryExporterError, type TelemetryExporterCatalogEntry } from "@marea/plugin-api";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { Clock } from "../identity/contracts.js";
import type { ServerSettingsStore } from "../server-settings/contracts.js";
import { SqliteTraceQueue } from "../platform/persistence/sqlite-trace-queue.js";
import { readTraceTurn } from "../platform/persistence/sqlite-trace-turn.js";
import { buildSessionTrace } from "./trace-builder.js";
import { redactTrace } from "./redaction.js";
import { deliverTrace } from "./delivery.js";

export class ObservabilityRuntime {
  readonly queue: SqliteTraceQueue;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<void> | undefined;
  private running = false;
  private healthy = true;
  constructor(
    readonly database: SqliteApplicationDatabase,
    readonly store: ServerSettingsStore,
    readonly catalog: readonly TelemetryExporterCatalogEntry[],
    readonly clock: Clock,
    readonly release: string,
    readonly secrets: () => readonly string[],
  ) {
    this.queue = new SqliteTraceQueue(database);
  }
  start() {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = true;
    this.schedule();
  }
  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.controller.abort();
    await this.task;
  }
  changed() {
    this.controller.abort();
    this.controller = new AbortController();
    const settings = this.store.read()?.observability;
    if (settings !== undefined) this.queue.configure(settings.epoch);
  }
  status() {
    const settings = this.store.read()?.observability;
    return {
      ...this.queue.status(),
      healthy: this.healthy,
      available: this.catalog.some(
        (entry) => entry.manifest.id === settings?.pluginId && entry.traces !== undefined,
      ),
    };
  }
  private schedule() {
    this.timer = setTimeout(() => {
      this.task = this.tick().finally(() => {
        if (this.running) this.schedule();
      });
    }, 1000);
  }
  /** One sequential, bounded batch; errors affect only delivery status, never student requests. */
  async tick(): Promise<void> {
    const signal = this.controller.signal;
    const cancelled = () => signal.aborted;
    try {
      const settings = this.store.read()?.observability;
      if (settings === undefined) return;
      this.queue.configure(settings.epoch);
      if (!settings.enabled) return;
      const implementation = this.catalog.find(
        (entry) => entry.manifest.id === settings.pluginId,
      )?.traces;
      if (implementation === undefined) return;
      this.queue.capture(this.clock.now());
      const exporter = implementation.create(settings.values);
      for (let delivered = 0; delivered < 8 && !cancelled(); delivered++) {
        const item = this.queue.next(this.clock.now());
        if (item === undefined) break;
        try {
          const turn = readTraceTurn(this.database, item);
          if (turn !== undefined)
            await deliverTrace(
              exporter,
              redactTrace(
                buildSessionTrace(turn, settings.namespace, this.release),
                this.secrets(),
              ),
              signal,
            );
          if (!cancelled()) this.queue.success(item, this.clock.now());
        } catch (error) {
          if (!cancelled())
            this.queue.failure(
              item,
              this.clock.now(),
              error instanceof TelemetryExporterError ? error.code : "unavailable",
            );
        }
      }
      this.healthy = true;
    } catch {
      this.healthy = false;
    }
  }
}
