import { TelemetryExporterError, type TelemetryExporterConnectionInput } from "@marea/plugin-api";

/** Validation only: deployment policy, secret lookup and activation belong to the host. */
export function snapshotConnection(connection: TelemetryExporterConnectionInput<"langfuse">) {
  try {
    const { endpoint, publicKey, secretKey } = connection;
    if (typeof endpoint !== "string" || /[\s\\?#]/u.test(endpoint)) throw new Error();
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    const keys = [publicKey, secretKey].map((key) => {
      if (typeof key !== "string" || !/^[\x21-\x39\x3b-\x7e]{1,1024}$/u.test(key))
        throw new Error();
      return key;
    });
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/public/otel/v1/traces`;
    return Object.freeze({
      endpoint: url.href,
      authorization: `Basic ${btoa(keys.join(":"))}`,
    });
  } catch {
    throw new TelemetryExporterError("invalid-configuration");
  }
}
