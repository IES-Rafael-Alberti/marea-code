import * as z from "zod";

import type { SqliteRow } from "@marea/sqlite-storage";

const StoredNumberSchema = z.number().int();

function storedDataError(): never {
  throw new Error("Stored teacher data is invalid.");
}

export function rowText(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    storedDataError();
  }
  return value;
}

export function rowNullableText(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  return rowText(row, key);
}

export function rowInteger(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value === "bigint") {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  const parsed = StoredNumberSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  storedDataError();
}

export function rowBoolean(row: SqliteRow, key: string): boolean {
  const value = rowInteger(row, key);
  if (value !== 0 && value !== 1) {
    storedDataError();
  }
  return value === 1;
}

export function rowJson<T>(row: SqliteRow, key: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(rowText(row, key));
  return schema.parse(value);
}
