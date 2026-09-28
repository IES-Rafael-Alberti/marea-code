import type {
  ActiveRunDashboardQuery,
  ActiveRunDashboardResponse,
  DashboardCursor,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";

export type DashboardRun = ActiveRunDashboardResponse["runs"][number];

export interface DashboardPage {
  readonly nextCursor: DashboardCursor | null;
  readonly runs: readonly DashboardRun[];
}

export interface DashboardRepository {
  listActiveRuns(input: {
    readonly cursor: ActiveRunDashboardQuery["cursor"];
    readonly limit: number;
    readonly teacherId: string;
  }): DashboardPage;
}

export interface DashboardQueryContext {
  readonly identity: AuthenticatedIdentity;
}
