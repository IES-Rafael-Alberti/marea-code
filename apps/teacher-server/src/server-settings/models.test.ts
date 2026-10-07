import { expect, it, vi } from "vitest";
import { InferenceProviderError } from "@marea/plugin-api";
import { inferenceProviderCatalog } from "@marea/plugin-runtime";
import { ServerSettingsService } from "./service.boundary.js";
import type { ServerSettings } from "./contracts.js";
const found = inferenceProviderCatalog[0];
if (!found) throw new Error("missing provider fixture");
const base = found;
const teacher = { userId: "owner", role: "teacher" as const, classId: null, displayName: "Owner" };
const encode = (input: object) => new TextEncoder().encode(JSON.stringify(input));
const model = { id: "synthetic/model", name: "Model", pricing: null };
function fixture() {
  const state: ServerSettings = {
    version: 1,
    revision: 0,
    administrators: [teacher.userId],
    connections: { [base.manifest.id]: { apiKey: "synthetic-saved-key" } },
    route: null,
    education: {},
    legacyRoutes: [],
    useCommonRoute: false,
  };
  const listModels = vi.fn().mockResolvedValue([model]);
  const write = vi.fn();
  const service = new ServerSettingsService({ read: () => state, write }, [
    { ...base, listModels },
  ]);
  const request = (values: Record<string, string> = {}, providerId = base.manifest.id) =>
    encode({ operation: "models", providerId, values });
  return { state, listModels, write, service, request };
}
it("checks draft credentials without saving and reuses an omitted saved secret", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await expect(f.service.execute(teacher, f.request(), signal)).resolves.toEqual({
    providerId: base.manifest.id,
    models: [model],
  });
  expect(f.listModels).toHaveBeenCalledExactlyOnceWith(
    {
      apiKey: "synthetic-saved-key",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      settings: {
        apiKey: "synthetic-saved-key",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
      },
    },
    signal,
  );
  await f.service.execute(
    teacher,
    f.request({
      apiKey: "synthetic-draft-key",
      endpoint: "https://custom.test/v1/chat/completions",
    }),
  );
  expect(f.listModels.mock.calls[1]?.[0]).toMatchObject({
    apiKey: "synthetic-draft-key",
    endpoint: "https://custom.test/v1/chat/completions",
  });
  expect(f.write).not.toHaveBeenCalled();
  expect(f.state.connections[base.manifest.id]?.apiKey).toBe("synthetic-saved-key");
});
it("requires administrator authorization before any credential check", () => {
  const f = fixture();
  for (const identity of [
    { ...teacher, userId: "other" },
    { ...teacher, role: "student" as const },
  ]) {
    expect(() => f.service.execute(identity, f.request())).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  }
  expect(f.listModels).not.toHaveBeenCalled();
});
it("rejects unsupported providers and malformed draft settings", async () => {
  const f = fixture();
  await expect(f.service.execute(teacher, f.request({}, "missing"))).rejects.toMatchObject({
    status: 422,
  });
  await expect(f.service.execute(teacher, f.request({ unknown: "secret" }))).rejects.toMatchObject({
    status: 400,
  });
  expect(f.listModels).not.toHaveBeenCalled();
});
it.each(["authentication-failed", "unavailable", "unexpected"])(
  "sanitizes provider errors: %s",
  async (code) => {
    const f = fixture();
    f.listModels.mockRejectedValue(
      code === "unexpected"
        ? new Error("private detail")
        : new InferenceProviderError({
            code: code as "authentication-failed" | "unavailable",
            message: "private detail",
            retryable: false,
          }),
    );
    await expect(f.service.execute(teacher, f.request())).rejects.toMatchObject({
      status: code === "authentication-failed" ? 400 : 503,
      message: "Server settings request failed",
    });
  },
);
it("rejects malformed plugin output", async () => {
  const f = fixture();
  f.listModels.mockResolvedValue([{ ...model, credential: "private" }]);
  await expect(f.service.execute(teacher, f.request())).rejects.toMatchObject({ status: 503 });
});

it("supports plugins whose model catalog does not require an API key or endpoint", async () => {
  const f = fixture();
  const plugin = {
    ...base,
    settings: { version: 1 as const, name: { es: "Local", en: "Local", eu: "Local" }, fields: [] },
    create: () => base.create({ apiKey: "synthetic-unused-key" }),
    listModels: f.listModels,
  };
  const service = new ServerSettingsService({ read: () => f.state, write: f.write }, [plugin]);
  await service.execute(teacher, f.request());
  expect(f.listModels).toHaveBeenCalledWith({ apiKey: "", settings: {} }, expect.any(AbortSignal));
});
