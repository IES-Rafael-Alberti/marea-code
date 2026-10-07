import {
  parseTelemetryExporterConfiguration,
  TelemetryExporterError,
  type TelemetryExporterConfiguration,
  type TelemetryExporterConnectionInput,
} from "@marea/plugin-api";

const reserved = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "content-encoding",
  "transfer-encoding",
  "accept",
  "accept-encoding",
  "proxy-authorization",
  "cookie",
]);

export function snapshot(
  configuration: TelemetryExporterConfiguration<"otlp">,
  connection: TelemetryExporterConnectionInput<"otlp">,
) {
  try {
    const settings = parseTelemetryExporterConfiguration(configuration);
    if (settings.destination !== "otlp") throw new Error();
    const endpointInput: unknown = connection.endpoint;
    if (typeof endpointInput !== "string") throw new Error();
    const endpoint = new URL(endpointInput);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error();
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/v1/metrics`;
    const headers = new Headers();
    const headerInput: unknown = connection.headers;
    if (!headerInput || typeof headerInput !== "object" || Array.isArray(headerInput))
      throw new Error();
    for (const [key, value] of Object.entries(headerInput)) {
      if (
        reserved.has(key.toLowerCase()) ||
        headers.has(key) ||
        typeof value !== "string" ||
        /[\r\n]/.test(value)
      )
        throw new Error();
      headers.set(key, value);
    }
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    headers.set("accept-encoding", "identity");
    return { settings, endpoint: endpoint.href, headers };
  } catch {
    throw new TelemetryExporterError("invalid-configuration");
  }
}
