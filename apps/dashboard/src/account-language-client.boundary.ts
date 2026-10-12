import { DashboardLanguageRequestSchema, DashboardLanguageResponseSchema } from "@marea/protocol";
import type { LocalePreference } from "@marea/i18n";
import { browserRandomUUID } from "./browser-random-uuid.js";
import { dashboardPost } from "./dashboard-post.js";
import type { DashboardFetch } from "./modules/active-runs/active-runs-client.boundary.js";
import { readSkillAuthoringResponse } from "./modules/skill-authoring/skill-authoring-response.boundary.js";

export function createAccountLanguageClient(fetch: DashboardFetch) {
  return async (
    preference: LocalePreference | null,
    signal: AbortSignal,
  ): Promise<LocalePreference | null> => {
    const request = DashboardLanguageRequestSchema.parse({
      protocolVersion: "0.1",
      requestId: `request:${browserRandomUUID()}`,
      ...(preference === null ? { kind: "read" } : { kind: "save", preference }),
    });
    const response = await fetch(
      "/api/v1/dashboard/profiles/language",
      dashboardPost(request, signal),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Dashboard language unavailable.");
    }
    const result = DashboardLanguageResponseSchema.parse(
      JSON.parse(await readSkillAuthoringResponse(response, 4096, signal)),
    );
    if (
      result.requestId !== request.requestId ||
      (preference !== null && result.preference !== preference)
    )
      throw new Error("Dashboard language response mismatch.");
    return result.preference;
  };
}
