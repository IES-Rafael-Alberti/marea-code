import type { RequestId } from "@marea/protocol";
import type * as z from "zod";
import type { DashboardModuleDescriptor, DashboardThemeDescriptor } from "@marea/plugin-api";
import type {
  DashboardModuleSelection,
  DashboardPersonalProfileValue,
  DashboardProfileScope,
} from "@marea/protocol";
import type { StoredDashboardProfile } from "@marea/sqlite-storage";
import type { AuthenticatedIdentity } from "../identity/contracts.js";

export interface DashboardProfileStore {
  transaction<T>(operation: () => T): T;
  authorized(ownerId: string, classId: string | null): boolean;
  read(ownerId: string, classId: string | null): StoredDashboardProfile | null;
  write(ownerId: string, classId: string | null, record: StoredDashboardProfile): void;
}
export interface DashboardProfileRelease<S extends DashboardModuleSelection> {
  readonly revision: string;
  readonly selection: z.ZodType<S>;
  readonly modules: readonly DashboardModuleDescriptor[];
  readonly themes: readonly DashboardThemeDescriptor[];
  readonly defaults: DashboardPersonalProfileValue<S>;
  readonly requiredIds: readonly string[];
  readonly capabilities: readonly string[];
}
export interface DashboardProfileAuthority {
  permits(
    identity: AuthenticatedIdentity,
    scope: DashboardProfileScope,
    module: DashboardModuleDescriptor,
  ): boolean;
}
export interface DashboardProfileEndpoint {
  execute(identity: AuthenticatedIdentity, operation: string, bytes: Uint8Array): object;
}
export class DashboardProfileError extends Error {
  public constructor(
    public readonly status: 400 | 403 | 409 | 413 | 422 | 500 | 503,
    public readonly requestId?: RequestId,
  ) {
    super("Dashboard profile operation unavailable.");
  }
}
