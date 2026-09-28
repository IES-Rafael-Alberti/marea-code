import { createHash } from "node:crypto";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { GovernanceResourceError } from "../../governance/errors.js";

/** Offline inventory remains bounded even when one mapped identity has dense history. */
export class GovernanceInventoryBudget {
  readonly hash = createHash("sha256");
  private rows = 0;
  private bytes = 0;
  constructor(private readonly database: SqliteApplicationDatabase) {}

  include(value: unknown): void {
    const text = JSON.stringify(value);
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > 16_777_216) throw new GovernanceResourceError();
    this.hash.update(text);
  }

  read(sql: string, identity: string) {
    const result = this.database.readAll(`${sql} LIMIT 10001`, [identity]);
    this.rows += result.length;
    if (result.length > 10000 || this.rows > 100000) throw new GovernanceResourceError();
    this.include(result);
    return result;
  }
}
