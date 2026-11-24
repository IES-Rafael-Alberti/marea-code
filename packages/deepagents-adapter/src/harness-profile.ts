import { registerHarnessProfile } from "deepagents";

import { GATEWAY_MODEL_PROFILE_KEY } from "./gateway-model.boundary.js";

/** The gateway model's own key, and the key of adapter test models that present as OpenAI. */
const PROFILE_KEYS = [GATEWAY_MODEL_PROFILE_KEY, "openai:marea"] as const;

/** Marea's tools replace DeepAgents' subagent: `task` is never offered and no subagent runs. */
export function registerMareaProfile(): void {
  for (const key of PROFILE_KEYS)
    registerHarnessProfile(key, {
      excludedTools: ["task"],
      generalPurposeSubagent: { enabled: false },
    });
}
