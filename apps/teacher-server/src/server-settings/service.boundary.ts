import { IdentitySettings, type IdentitySettingsOptions } from "./identity-settings.js";
import { prepareConnections, projectConnection } from "./connections.js";
import { providerModels } from "./models.js";
import { usesCommonRoute } from "./operator.js";
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
  z.object({ operation: z.literal("identity-status") }).strict(),
  z.object({ operation: z.literal("identity-read") }).strict(),
  z
    .object({
      operation: z.literal("identity-save"),
      expectedRevision: z.number().int().nonnegative(),
      connections: ServerSettingsSchema.shape.identityConnections.unwrap(),
    })
    .strict(),
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({
      operation: z.literal("models"),
      providerId: z.string().min(1).max(128),
      values: z.record(z.string().max(64), z.string().max(2048)),
    })
    .strict(),
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
    readonly connectionOrigins: readonly string[] = [],
    readonly identities?: IdentitySettingsOptions,
  ) {}
  execute(
    identity: AuthenticatedIdentity,
    input: Uint8Array,
    signal = new AbortController().signal,
  ): object | Promise<object> {
    if (identity.role !== "teacher") throw new ServerSettingsError(403);
    const parsed = Input.safeParse(decodeJson(input));
    if (!parsed.success) throw new ServerSettingsError(400);
    const current = this.store.read();
    const administrator = current?.administrators.includes(identity.userId) === true;
    if (isIdentityOperation(parsed.data))
      return executeIdentityOperation(
        this.store,
        this.identities,
        current,
        identity.userId,
        parsed.data,
      );
    if (!administrator) {
      if (parsed.data.operation !== "read") throw new ServerSettingsError(403);
      return { administrator: false, initialized: current !== null };
    }
    if (parsed.data.operation === "models")
      return providerModels(
        this.catalog,
        current,
        parsed.data.providerId,
        parsed.data.values,
        signal,
      );
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
        useCommonRoute: usesCommonRoute({
          ...current,
          route: q.route,
          useCommonRoute: q.useCommonRoute,
        }),
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
      connectionOrigins: this.connectionOrigins,
      legacyRoutes: current.legacyRoutes,
      route: current.route,
      education: current.education,
      useCommonRoute: usesCommonRoute(current),
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

type IdentityOperation = Extract<z.infer<typeof Input>, { operation: `identity-${string}` }>;
function isIdentityOperation(input: z.infer<typeof Input>): input is IdentityOperation {
  return input.operation.startsWith("identity-");
}
function executeIdentityOperation(
  store: ServerSettingsStore,
  options: IdentitySettingsOptions | undefined,
  current: ServerSettings | null,
  userId: string,
  input: IdentityOperation,
): object {
  const service = options === undefined ? undefined : new IdentitySettings(store, options);
  if (input.operation === "identity-status") return service?.status() ?? { providers: [] };
  if (!current?.administrators.includes(userId)) throw new ServerSettingsError(403);
  if (service === undefined) throw new ServerSettingsError(404);
  return input.operation === "identity-read"
    ? service.read(current)
    : service.save(current, input.expectedRevision, input.connections);
}
