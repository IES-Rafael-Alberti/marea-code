import { expect, it, vi } from "vitest";
import {
  observabilityFixture,
  completeTurn,
  encode,
} from "../../observability/observability.fixture.js";
import { composeObservability, observabilityEndpoint } from "./observability-composition.js";
import { clock } from "../../../test-support/teaching-integration.fixture.js";

it("requires installed storage and settings, and resolves private secrets only on the server", async () => {
  const f = observabilityFixture();
  try {
    const config = { catalog: f.catalog, release: "release-test" };
    expect(composeObservability(f.database, clock, undefined, config)).toBeUndefined();
    expect(composeObservability(f.database, clock, f.store, undefined)).toBeUndefined();
    expect(observabilityEndpoint(undefined)).toEqual({});
    const runtime = composeObservability(f.database, clock, f.store, config);
    if (!runtime) throw new Error("Missing runtime");
    expect(runtime.secrets()).toEqual([]);
    vi.spyOn(f.store, "read").mockReturnValueOnce(null);
    expect(runtime.secrets()).toEqual([]);
    const current = f.store.read();
    if (!current) throw new Error("fixture");
    f.store.write(
      { ...current, connections: { provider: { apiKey: "provider-key" } } },
      current.revision,
    );
    await f.save();
    expect(runtime.secrets()).toEqual(["provider-key", "https://collector.test", "synthetic-key"]);
    const endpoint = observabilityEndpoint(runtime).observability;
    expect(await endpoint?.execute(f.teacher, encode({ operation: "read" }))).toMatchObject({
      enabled: true,
    });
    completeTurn(f.database);
    await runtime.tick();
    expect(f.traces[0]?.release).toBe("release-test");
    f.database.execute("DROP TABLE marea_trace_outbox");
    expect(composeObservability(f.database, clock, f.store, config)).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});
