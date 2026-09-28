import type { TeacherHostOptions } from "./teacher-host.js";
import { composeDashboardProfiles } from "./profile-composition.js";
import { release } from "../../dashboard-profiles/release.fixture.js";

export function syntheticProfileHostServices(
  createId: () => string,
): Pick<TeacherHostOptions, "passwords" | "profiles" | "onEvaluationError"> {
  return {
    passwords: {
      hash: (value) => Promise.resolve(`hash:${value}`),
      verify: (value, hash) => Promise.resolve(hash === `hash:${value}`),
    },
    onEvaluationError() {
      throw new Error("Unexpected evaluation failure");
    },
    profiles: (database) =>
      composeDashboardProfiles({
        database,
        release,
        authority: { permits: () => true },
        currentCatalogRevision: () => release.revision,
        clock: { now: () => "2026-09-22T12:00:00Z" },
        ids: { createId },
      }),
  };
}
