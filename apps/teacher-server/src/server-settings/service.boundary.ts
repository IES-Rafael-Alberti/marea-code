import { prepareConnections, projectConnection } from "./connections.js";
import * as z from "zod";
import { type InferenceProviderCatalogEntry } from "@marea/plugin-api";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import {
  ServerSettingsError,
  ServerSettingsSchema,
  type ServerSettings,
  type ServerSettingsStore,
} from "./contracts.js";

const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({
      operation: z.literal("save"),
      expectedRevision: z.number().int().nonnegative(),
      connections: ServerSettingsSchema.shape.connections,
      route: ServerSettingsSchema.shape.route,
      education: ServerSettingsSchema.shape.education,
      useCommonRoute: z.boolean(),
    })
    .strict(),
]);
/** Secret fields are accepted on writes, but only their presence is projected on reads. */
export class ServerSettingsService {
  constructor(
    readonly store: ServerSettingsStore,
    readonly catalog: readonly InferenceProviderCatalogEntry[],
    readonly changed?: (settings: ServerSettings) => void,
  ) {}
  execute(identity: AuthenticatedIdentity, input: Uint8Array): object {
    if (identity.role !== "teacher") throw new ServerSettingsError(403);
    const parsed = Input.safeParse(decodeJson(input));
    if (!parsed.success) throw new ServerSettingsError(400);
    const current = this.store.read();
    const administrator = current?.administrators.includes(identity.userId) === true;
    if (!administrator) {
      if (parsed.data.operation !== "read") throw new ServerSettingsError(403);
      return { administrator: false, initialized: current !== null };
    }
    if (parsed.data.operation === "save") {
      const q = parsed.data;
      if (q.expectedRevision !== current.revision) throw new ServerSettingsError(409);
      const connections = prepareConnections(this.catalog, q.connections, current.connections);
      for (const route of [q.route, q.education.map, q.education.reports]) {
        if (route && (connections[route.providerId] === undefined || route.budget === undefined))
          throw new ServerSettingsError(400);
      }
      // Imported class routes still resolve through these connections until they are replaced.
      const selected = [q.route, ...current.legacyRoutes.map((item) => item.route)].flatMap(
        (route) => (route === null ? [] : [route.providerId, route.evaluation?.providerId]),
      );
      if (selected.some((id) => id !== undefined && connections[id] === undefined))
        throw new ServerSettingsError(400);
      if (q.useCommonRoute && q.route === null) throw new ServerSettingsError(400);
      const next = ServerSettingsSchema.parse({
        ...current,
        route: q.route,
        education: q.education,
        useCommonRoute: q.useCommonRoute,
        connections,
        revision: current.revision + 1,
      });
      this.store.write(next, current.revision);
      this.changed?.(next);
      return this.execute(
        identity,
        new TextEncoder().encode(JSON.stringify({ operation: "read" })),
      );
    }
    return {
      administrator: true,
      initialized: true,
      revision: current.revision,
      legacyRoutes: current.legacyRoutes,
      route: current.route,
      education: current.education,
      useCommonRoute: current.useCommonRoute,
      providers: [
        ...this.catalog.map((entry) => projectConnection(entry, current.connections)),
        ...Object.keys(current.connections)
          .filter((id) => !this.catalog.some((entry) => entry.manifest.id === id))
          .map((id) => ({ id, descriptor: null, configured: true, values: {}, secrets: [] })),
      ],
    };
  }
}

/** Malformed UTF-8 or JSON becomes an absent value, which the closed input schema rejects. */
function decodeJson(input: Uint8Array) {
  let decoded: object | undefined;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as object;
  } catch {
    // Left undefined.
  }
  return decoded;
}
