import { expect, it, vi } from "vitest";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import { managedProviderResolver } from "./managed-provider-resolver.js";
it("retains admitted providers while new admissions use replacement credentials", () => {
  const base = inferenceProviderCatalog[0];
  if (!base) throw new Error("missing fixture");
  const create = vi.fn(base.create);
  let state: { revision: number; connections: Record<string, Record<string, string>> } | null =
    null;
  const resolver = managedProviderResolver([{ ...base, create }], () => state, {
    [base.manifest.id]: { apiKey: "synthetic-original-key" },
  });
  const original = resolver.resolve(base.manifest.id);
  expect(resolver.resolve(base.manifest.id)).toBe(original);
  state = {
    revision: 1,
    connections: { [base.manifest.id]: { apiKey: "synthetic-replacement-key" } },
  };
  const next = resolver.resolve(base.manifest.id);
  expect(next).not.toBe(original);
  expect(original).toHaveProperty("stream");
  expect(create).toHaveBeenCalledTimes(2);
  state = { revision: 2, connections: {} };
  expect(resolver.resolve(base.manifest.id)).toBeUndefined();
  expect(resolver.resolve("missing")).toBeUndefined();
});
it("uses only managed connections once settings exist, passing endpoints and plugin fields", () => {
  const base = inferenceProviderCatalog[0];
  if (!base) throw new Error("missing fixture");
  const create = vi.fn(base.create);
  let state: { revision: number; connections: Record<string, Record<string, string>> } | null = {
    revision: 3,
    connections: {
      [base.manifest.id]: {
        apiKey: "synthetic-managed-key",
        endpoint: "https://provider.example.test/v1/chat/completions",
      },
      "org.marea.removed-plugin": { apiKey: "synthetic-orphan-key" },
    },
  };
  const resolver = managedProviderResolver([{ ...base, create }], () => state, {
    [base.manifest.id]: { apiKey: "synthetic-legacy-key" },
  });
  const provider = resolver.resolve(base.manifest.id);
  expect(resolver.resolve(base.manifest.id)).toBe(provider);
  expect(create).toHaveBeenCalledExactlyOnceWith({
    apiKey: "synthetic-managed-key",
    endpoint: "https://provider.example.test/v1/chat/completions",
    settings: state.connections[base.manifest.id],
  });
  // A stored connection whose plugin is no longer installed never resolves.
  expect(resolver.resolve("org.marea.removed-plugin")).toBeUndefined();
  // Legacy credentials are not a fallback once the server owns its connections.
  state = null;
  expect(resolver.resolve(base.manifest.id)).toBeUndefined();
});

it("passes plugin-specific fields when a connection has no API key field", () => {
  const base = inferenceProviderCatalog[0];
  if (!base) throw new Error("missing fixture");
  const create = vi.fn((configuration: Parameters<typeof base.create>[0]) =>
    base.create({ ...configuration, apiKey: "synthetic-validated-key" }),
  );
  const resolver = managedProviderResolver(
    [{ ...base, create }],
    () => ({ revision: 0, connections: { [base.manifest.id]: { token: "synthetic-token" } } }),
    {},
  );
  expect(resolver.resolve(base.manifest.id)).toBeDefined();
  // No endpoint key at all, so the plugin applies its own default.
  expect(create.mock.calls[0]?.[0]).toStrictEqual({
    apiKey: "",
    settings: { token: "synthetic-token" },
  });
});
