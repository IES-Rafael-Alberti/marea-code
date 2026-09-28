import { snapshotTelemetryPort, discardTelemetryPort } from "./port-ownership.js";
import type {
  TelemetryExporterCatalogEntry,
  TelemetryExporterConfiguration,
  TelemetryExporterCredentialResolver,
  TelemetryExporterDestination,
  TelemetryExporterPort,
} from "@marea/plugin-api";
import { createOperationalTelemetry } from "@marea/telemetry-pipeline";
import { telemetryRuntimeConfigurationSchema } from "./runtime-configuration.boundary.js";

export interface TelemetryRuntimeOptions {
  readonly configuration?: unknown;
  readonly catalog: readonly TelemetryExporterCatalogEntry[];
  readonly resolver: TelemetryExporterCredentialResolver;
  readonly signal: AbortSignal;
}

type DestinationState = "ready" | "unavailable";

async function construct(
  implementation: NonNullable<TelemetryExporterCatalogEntry["implementation"]>,
  settings: TelemetryExporterConfiguration,
  resolver: TelemetryExporterCredentialResolver,
  signal: AbortSignal,
  own: (port: TelemetryExporterPort) => void,
): Promise<void> {
  if (implementation.destination === "otlp") {
    const connection = await resolver.resolve("otlp", signal);
    signal.throwIfAborted();
    own(implementation.create({ ...settings, destination: "otlp" }, connection));
    return;
  }
  const connection = await resolver.resolve("langfuse", signal);
  signal.throwIfAborted();
  own(implementation.create({ ...settings, destination: "langfuse" }, connection));
}

/** One deadline for all resolution; late promises cannot construct ports. */
export async function startTelemetryRuntime(options: TelemetryRuntimeOptions) {
  const parsed = telemetryRuntimeConfigurationSchema().safeParse(options.configuration);
  const states: Partial<Record<TelemetryExporterDestination, DestinationState>> = {};
  const disabled = (state: "disabled" | "invalid") => ({
    runtime: createOperationalTelemetry(),
    health: Object.freeze({ state, destinations: Object.freeze(states) }),
  });
  if (options.configuration === undefined) return disabled("disabled");
  if (!parsed.success) return disabled("invalid");
  const config = parsed.data;
  if (!config.enabled) return disabled("disabled");
  const destinations = config.exporters.map((entry) => entry.destination);
  if (new Set(destinations).size !== destinations.length || destinations.length === 0)
    return disabled("invalid");
  const timeoutMs = Math.min(...config.exporters.map((entry) => entry.operationTimeoutMs));
  const controller = new AbortController();
  const interrupted = Promise.withResolvers<undefined>();
  const cancel = () => {
    controller.abort();
    interrupted.resolve(undefined);
  };
  const timer = setTimeout(cancel, config.startupTimeoutMs);
  options.signal.addEventListener("abort", cancel);
  if (options.signal.aborted) cancel();
  const discarded = new Set<TelemetryExporterPort>();
  const adapters: Partial<Record<TelemetryExporterDestination, TelemetryExporterPort>> = {};
  try {
    await Promise.all(
      config.exporters.map(async (settings) => {
        const destination = settings.destination;
        const matches = options.catalog.filter(
          (entry) => entry.implementation?.destination === destination,
        );
        const implementation = matches.length > 1 ? undefined : matches.pop()?.implementation;
        states[destination] = "unavailable";
        if (
          implementation === undefined ||
          typeof implementation.create !== "function" ||
          controller.signal.aborted
        )
          return;
        try {
          await Promise.race([
            construct(
              implementation,
              { ...settings, operationTimeoutMs: timeoutMs },
              options.resolver,
              controller.signal,
              (port) => {
                try {
                  adapters[destination] = snapshotTelemetryPort(destination, port);
                } catch {
                  discarded.add(port);
                  return;
                }
                states[destination] = "ready";
              },
            ),
            interrupted.promise,
          ]);
        } catch {
          // Failed resolution/construction retains the initial unavailable state.
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
  }
  await Promise.all(Array.from(discarded, (port) => discardTelemetryPort(port, timeoutMs)));
  const selected = destinations.filter((destination) => adapters[destination] !== undefined);
  const runtime = createOperationalTelemetry(
    {
      enabled: true,
      destinations: selected,
      operationTimeoutMs: timeoutMs,
      maxInFlight: config.maxInFlight,
    },
    adapters,
  );
  if (options.signal.aborted) {
    await runtime.close(new AbortController().signal);
    for (const destination of selected) states[destination] = "unavailable";
    return {
      runtime: createOperationalTelemetry(),
      health: Object.freeze({ state: "cancelled", destinations: Object.freeze(states) }),
    };
  }
  return {
    runtime,
    health: Object.freeze({ state: "configured", destinations: Object.freeze(states) }),
  };
}
