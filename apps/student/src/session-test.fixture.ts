import type { MemoryStateStore } from "./student.fixture.js";

const EXPIRING_LEASE = "2026-09-03T10:00:30.000Z";

export function setFixtureLeaseExpiry(
  state: MemoryStateStore,
  leaseExpiresAt = EXPIRING_LEASE,
): void {
  const run = state.state.run;
  if (run === null) throw new Error("Fixture run missing.");
  state.state = { ...state.state, run: { ...run, leaseExpiresAt } };
}
