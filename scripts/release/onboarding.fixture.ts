import type { ServerSetupRequest } from "@marea/protocol";
import { SYNTHETIC_ROUTE_BUDGET } from "../../apps/teacher-server/test-support/usage-fixture.js";
export const setupInput = (overrides: Partial<ServerSetupRequest> = {}): ServerSetupRequest => ({
  center: "Synthetic school",
  classroom: "Trial class",
  teacher: "Teacher",
  login: "teacher",
  password: "synthetic-onboarding-password",
  port: 18793,
  access: "lan",
  publicOrigin: "",
  connections: { "org.marea.openrouter": { apiKey: "synthetic-api-key" } },
  route: {
    providerId: "org.marea.openrouter",
    model: "synthetic/classroom",
    budget: SYNTHETIC_ROUTE_BUDGET,
  },
  testingSkill: false,
  ...overrides,
});
export function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test value");
  return value;
}
