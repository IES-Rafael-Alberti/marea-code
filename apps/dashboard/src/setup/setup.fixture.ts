import type { ServerSetupRequest } from "@marea/protocol";
import { emptyBudget } from "../modules/server-settings/budget-fields.js";
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value");
  return value;
}
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
    budget: { inputTokenCeiling: 131072, tutoring: emptyBudget(), evaluation: emptyBudget() },
  },
  testingSkill: false,
  ...overrides,
});
