import { describe, expect, it } from "vitest";

import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { seedTeachingDatabase } from "../../../test-support/teaching-integration.fixture.js";
import { SqliteTeachingDashboardRepository } from "./sqlite-teaching-dashboard-repository.js";

describe("SQLite teaching dashboard directory", () => {
  it("lists assigned classes in binary order with an exclusive keyset cursor", async () => {
    const database = new NodeSqliteTestDatabase();
    try {
      seedTeachingDatabase(database);
      database.execute(
        "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:three', 'three', 'Three')",
      );
      database.execute(
        "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('t1', 'class:three')",
      );
      const directory = new SqliteTeachingDashboardRepository(database);
      expect(
        await directory.listClasses({ afterClassId: null, limit: 2, teacherId: "t1" }),
      ).toEqual([
        { classId: "class:one", displayName: "one" },
        { classId: "class:three", displayName: "Three" },
      ]);
      expect(
        await directory.listClasses({ afterClassId: "class:one", limit: 2, teacherId: "t1" }),
      ).toEqual([{ classId: "class:three", displayName: "Three" }]);
      expect(
        await directory.listClasses({ afterClassId: "class:three", limit: 2, teacherId: "t1" }),
      ).toEqual([]);
      expect(
        await directory.listClasses({ afterClassId: null, limit: 2, teacherId: "t2" }),
      ).toEqual([{ classId: "class:two", displayName: "two" }]);
      expect(
        await directory.listClasses({ afterClassId: null, limit: 2, teacherId: "t3" }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});
