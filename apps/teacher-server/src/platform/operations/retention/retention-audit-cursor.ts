import type { AuditOperationState } from "@marea/sqlite-storage";

import type { AuditStore } from "../storage/application-audit-store.js";

/** Advances one audit operation from the state this process last observed. */
export class RetentionAuditCursor {
  public constructor(
    private readonly audit: AuditStore,
    private readonly operationId: string,
    private state: AuditOperationState,
    private readonly now: string,
  ) {}

  public advance(nextState: AuditOperationState, errorCode: string | null = null): void {
    this.audit.advance({
      operationId: this.operationId,
      expectedState: this.state,
      nextState,
      now: this.now,
      errorCode,
    });
    this.state = nextState;
  }
}
