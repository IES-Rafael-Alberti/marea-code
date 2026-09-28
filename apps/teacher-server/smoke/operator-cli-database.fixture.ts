import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { z } from "zod";

export function readOperatorRows(databasePath: string, sql: string) {
  const storage = initializeSqliteStorage({ databasePath });
  try {
    return z
      .array(
        z.record(
          z.string(),
          z.union([z.bigint().transform((value) => value.toString()), z.json()]),
        ),
      )
      .parse(storage.database.readAll(sql));
  } finally {
    storage.close();
  }
}
