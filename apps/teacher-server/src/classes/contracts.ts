import type { AuthenticatedIdentity } from "../identity/contracts.js";

export interface StudentClassBootstrap {
  readonly activeRun: {
    readonly projectDisplayName: string;
    readonly runId: string;
  } | null;
  readonly classDisplayName: string;
}

export interface ClassroomRepository {
  loadStudentBootstrap(identity: AuthenticatedIdentity): StudentClassBootstrap | undefined;
}
