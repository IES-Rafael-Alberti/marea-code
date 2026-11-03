import { expect, it, vi } from "vitest";

it("loads every freshness variant and rejects missing discriminators on a fresh import", async () => {
  vi.resetModules();
  const { DashboardFreshnessSchema } = await import("./dashboard-contracts.js");
  for (const value of [
    { kind: "on-demand" },
    { kind: "poll", intervalMs: 1000 },
    { kind: "live", reconnectMs: 1000, fallbackIntervalMs: 1000 },
  ])
    expect(DashboardFreshnessSchema.parse(value)).toEqual(value);
  for (const value of [{}, { kind: "unknown" }, { intervalMs: 1000 }])
    expect(DashboardFreshnessSchema.safeParse(value)).toMatchObject({
      success: false,
      error: { issues: [{ path: ["kind"] }] },
    });
});
