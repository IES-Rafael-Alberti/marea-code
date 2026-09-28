import {
  activeGovernanceAccount,
  activeGovernanceMembership,
} from "../persistence/governance-access-sql.js";
import { createDashboardProfileStore, type SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { DashboardModuleSelection } from "@marea/protocol";
import type { Clock, IdGenerator } from "../../identity/contracts.js";
import type {
  DashboardProfileAuthority,
  DashboardProfileRelease,
} from "../../dashboard-profiles/contracts.js";
import { createDashboardProfileService } from "../../dashboard-profiles/service.boundary.js";

/** Inject the release's typed selection union and pure descriptors; never import browser code. */
export function composeDashboardProfiles<S extends DashboardModuleSelection>(options: {
  readonly database: SqliteApplicationDatabase;
  readonly release: DashboardProfileRelease<S>;
  readonly authority: DashboardProfileAuthority;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly currentCatalogRevision: () => string;
}) {
  const store = createDashboardProfileStore(options.database);
  const authorized = (ownerId: string, classId: string | null): boolean =>
    store.authorized(ownerId, classId) &&
    options.database.readOne(
      `SELECT 1 WHERE ${activeGovernanceAccount("?1")} AND
       (?2 IS NULL OR ${activeGovernanceMembership("?1", "?2", "'teacher'")})`,
      [ownerId, classId],
    ) !== undefined;
  return createDashboardProfileService({
    ...options,
    store: { ...store, authorized },
  });
}
