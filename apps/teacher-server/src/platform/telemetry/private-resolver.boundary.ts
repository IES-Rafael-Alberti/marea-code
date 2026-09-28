import { join } from "node:path";
import { z } from "zod";
import {
  TelemetryExporterError,
  type TelemetryExporterCredentialResolver,
  type TelemetryExporterConnections,
} from "@marea/plugin-api";
import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { currentUid, privateDescendantKind } from "../operator-cli/private-path.js";

const endpoint = z.url().refine((input) => {
  const url = new URL(input);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
});
const otlp = z.object({ endpoint, headers: z.record(z.string(), z.string()) }).strict();
const langfuse = z
  .object({ endpoint, publicKey: z.string().min(1), secretKey: z.string().min(1) })
  .strict();

/** Same private, canonical, owner-only filesystem boundary as host credentials. No environment fallback. */
export function privateTelemetryResolver(
  root: string,
  uid = currentUid(),
): TelemetryExporterCredentialResolver {
  const read = (destination: string, signal: AbortSignal): unknown => {
    signal.throwIfAborted();
    const path = join(root, "config", `telemetry-${destination}.json`);
    if (privateDescendantKind(root, path, uid) !== "file") throw new Error();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readBoundedBytes(path, 16_384)),
    );
    return value;
  };
  return {
    resolve: async <D extends "otlp" | "langfuse">(destination: D, signal: AbortSignal) => {
      try {
        const value = read(destination, signal);
        // Conditional public resolver signature relates each destination to its private shape.
        return await Promise.resolve(
          (destination === "otlp"
            ? otlp.parse(value)
            : langfuse.parse(value)) as TelemetryExporterConnections[D],
        );
      } catch {
        throw new TelemetryExporterError("unavailable");
      }
    },
  };
}
