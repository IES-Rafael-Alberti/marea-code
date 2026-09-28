import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Parameter = SQLInputValue | boolean;
interface OpenOptions {
  readonly readonly?: boolean;
  readonly safeIntegers?: boolean;
}

/** Records every native open so tests can prove read-only probes and closes. */
export const nativeOpens: { path: string; options: OpenOptions; closed: boolean }[] = [];

const values = (parameters: readonly Parameter[]) =>
  parameters.map((value) => (typeof value === "boolean" ? Number(value) : value));

/** The subset of `bun:sqlite` used by the storage driver and schema probe, backed by node:sqlite. */
export class Database {
  readonly #database: DatabaseSync;
  readonly #record: (typeof nativeOpens)[number];

  constructor(path: string, options: OpenOptions = {}) {
    this.#database = new DatabaseSync(path, {
      readOnly: options.readonly === true,
      readBigInts: options.safeIntegers === true,
    });
    this.#record = { path, options, closed: false };
    nativeOpens.push(this.#record);
  }

  run(sql: string, parameters: readonly Parameter[] = []): void {
    if (sql.trim() === "") throw new Error("SQL string mustn't be blank");
    if (parameters.length === 0) this.#database.exec(sql);
    else this.#statement(sql).run(...values(parameters));
  }

  /**
   * Bun rejects SQL without a statement while preparing. node:sqlite instead returns a finalized
   * handle; never pass that handle into its native statement methods.
   */
  #statement(sql: string) {
    const statement = this.#database.prepare(sql);
    try {
      if (statement.sourceSQL !== "") return statement;
    } catch {
      // A finalized handle has no source SQL.
    }
    throw new Error("Query contained no valid SQL statement; likely empty query.");
  }

  prepare(sql: string) {
    const statement = this.#statement(sql);
    return {
      all: (...parameters: Parameter[]) => statement.all(...values(parameters)),
      get: (...parameters: Parameter[]) => statement.get(...values(parameters)) ?? null,
      finalize: () => undefined,
    };
  }

  query(sql: string) {
    return this.prepare(sql);
  }

  serialize(): Uint8Array {
    const directory = mkdtempSync(join(tmpdir(), "marea-cli-serialize-"));
    try {
      const path = join(directory, "copy.sqlite");
      this.#database.prepare("VACUUM INTO ?1").run(path);
      return new Uint8Array(readFileSync(path));
    } finally {
      rmSync(directory, { recursive: true });
    }
  }

  close(): void {
    this.#record.closed = true;
    this.#database.close();
  }
}
