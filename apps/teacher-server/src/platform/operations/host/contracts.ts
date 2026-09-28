import type {
  ReadOnlySqliteApplicationDatabase,
  ReferenceGraphReader,
  RecoveryInspection,
} from "../contracts.js";
import type { IndexInspection, OperationErrorCode } from "../schemas.js";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

export type HostDatabaseMode = "read-only" | "read-write";

export interface HostDatabaseHandle {
  readonly mode: HostDatabaseMode;
  readonly database: ReadOnlySqliteApplicationDatabase | SqliteApplicationDatabase;
  close(): void | Promise<void>;
}

export interface HostInstallationConfig {
  readonly releaseId: string;
  readonly schemaVersion: number;
  readonly databasePath: string;
  readonly indexPath: string;
  readonly statusPath: string;
}

export interface HostConfigurationPort {
  read(input: {
    readonly installationRoot: string;
    readonly requestedReleaseId?: string;
  }): Promise<HostInstallationConfig>;
  validate(input: {
    readonly installationRoot: string;
    readonly config: HostInstallationConfig;
    readonly requestedReleaseId: string;
  }): Promise<void>;
}

export interface HostRecoveryPort {
  inspect(): Promise<RecoveryInspection>;
}

export interface HostIndexPort {
  inspect(): Promise<IndexInspection>;
}

export interface HostStoragePort {
  open(input: {
    readonly installationRoot: string;
    readonly config: HostInstallationConfig;
    readonly mode: HostDatabaseMode;
  }): Promise<HostDatabaseHandle>;
}

export type HostStatus = "starting" | "ready" | "draining" | "stopped" | "failed";

export interface HostStatusRecord {
  readonly status: HostStatus;
  readonly releaseId: string | null;
  readonly schemaVersion: number | null;
  readonly reasonCode: string;
  readonly observedAt: string;
}

export interface HostStatusPort {
  read(input: {
    readonly installationRoot: string;
    readonly statusPath: string;
  }): Promise<HostStatusRecord | null>;
  write(input: {
    readonly installationRoot: string;
    readonly statusPath: string;
    readonly value: HostStatusRecord;
  }): Promise<void>;
}

export interface InstallationLock {
  readonly canonicalRoot: string;
  /**
   * A failed release may leave ownership uncertain and retryable.  Adapters
   * that can distinguish a replaced/foreign path expose the terminal state so
   * callers can dispose the descriptor without retaining a closed retry owner.
   */
  readonly releaseState?: "owned" | "released" | "ownership-lost";
  release(): Promise<void>;
}

export interface InstallationExclusivity {
  acquire(installationRoot: string): Promise<InstallationLock>;
  inspect(installationRoot: string): Promise<"free" | "held" | "unknown">;
}

export interface HostDrainPort {
  drain(input: { readonly drainUntil: string }): Promise<"drained" | "expired">;
  resume(): void;
}

export interface HostClock {
  now(): string;
}

export interface HostLifecycleDependencies {
  readonly configuration: HostConfigurationPort;
  readonly exclusivity: InstallationExclusivity;
  readonly recovery: HostRecoveryPort;
  readonly index: HostIndexPort;
  readonly storage: HostStoragePort;
  readonly status: HostStatusPort;
  readonly drain: HostDrainPort;
  readonly clock: HostClock;
}

export interface HostMaintenanceDependencies extends HostLifecycleDependencies {
  readonly installationRoot: string;
  readonly graph: ReferenceGraphReader;
}

export interface HostRuntimeDependencies extends HostLifecycleDependencies {
  readonly installationRoot?: string;
  readonly graph?: ReferenceGraphReader;
}

export class HostOperationError extends Error {
  public readonly code: OperationErrorCode;

  public constructor(code: OperationErrorCode, message: string) {
    super(message);
    this.name = "HostOperationError";
    this.code = code;
  }
}
