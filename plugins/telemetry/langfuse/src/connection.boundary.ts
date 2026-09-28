import { TelemetryExporterError, type TelemetryExporterConnections } from "@marea/plugin-api";

/** Validation only: deployment policy, secret lookup and activation belong to the host. */
export function snapshotConnection(connection: TelemetryExporterConnections["langfuse"]) {
  try {
    const { endpoint, publicKey, secretKey } = connection;
    if (typeof endpoint !== "string" || /[\s\\?#]/u.test(endpoint)) throw new Error();
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    for (const key of [publicKey, secretKey]) {
      if (typeof key !== "string" || !/^[\x21-\x39\x3b-\x7e]{1,1024}$/u.test(key))
        throw new Error();
    }
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/public/otel/v1/traces`;
    return Object.freeze({
      endpoint: url.href,
      authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`,
    });
  } catch {
    throw new TelemetryExporterError("invalid-configuration");
  }
}
