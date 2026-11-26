import { randomUUID } from "node:crypto";
import { InsightsSettingsSchema, type InsightsSettings } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { TeacherDomainError } from "../identity/errors.js";

/** A class's educational settings, usable without the model-backed parts of progress. */
export class LearningSettings {
  constructor(readonly database: SqliteApplicationDatabase) {}
  settings(classId: string): { settings: InsightsSettings; revision: string } {
    const row = this.database.readOne("SELECT * FROM marea_learning_settings WHERE class_id = ?1", [
      classId,
    ]);
    return row === undefined
      ? { settings: { map: false, adaptive: false }, revision: "initial" }
      : {
          settings: InsightsSettingsSchema.parse(JSON.parse(String(row.value_json))),
          revision: String(row.revision),
        };
  }
  configure(
    classId: string,
    value: InsightsSettings,
    revision: string,
    authorize: () => void = () => undefined,
  ) {
    return this.database.transaction(() => {
      authorize();
      if (this.settings(classId).revision !== revision)
        throw new TeacherDomainError("request.conflict");
      this.database.execute(
        "INSERT INTO marea_learning_settings VALUES (?1, ?2, ?3) ON CONFLICT(class_id) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json",
        [classId, randomUUID(), JSON.stringify(value)],
      );
      return this.settings(classId);
    });
  }
}
