import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteParameter } from "./contracts.js";
import {
  governanceDatabase,
  seedGovernanceScopes,
} from "../test-support/governance-database.fixture.js";

let fixture: ReturnType<typeof governanceDatabase>;
beforeEach(() => {
  fixture = governanceDatabase();
  seedGovernanceScopes(fixture.database);
});
afterEach(() => {
  fixture.close();
});

const created = "2026-09-12T08:00:00.000Z";
const expires = "2026-09-12T08:10:00.000Z";
function membership(
  classId: string,
  centerId: string,
  userId = "student-1",
  role = "student",
  state = "active",
) {
  fixture.database
    .prepare("INSERT INTO marea_governance_memberships VALUES (?, ?, ?, ?, ?, 'v1', ?, ?)")
    .run(classId, centerId, userId, role, state, created, created);
}
function preview(overrides: Readonly<Record<string, Exclude<SqliteParameter, boolean>>> = {}) {
  const fields = {
    id: "preview-1",
    center_id: "center-1",
    class_id: "class-1",
    authority: "administrator",
    user_id: "teacher-1",
    session_id: "session-1",
    expected_teaching_version: null,
    expected_class_version: "v1",
    operator_fingerprint: "private-fingerprint",
    package_digest: "package-digest",
    package_json: "{}",
    settings_json: "{}",
    created_at: created,
    expires_at: expires,
    state: "pending",
    result_revision_id: null,
    ...overrides,
  };
  fixture.database
    .prepare(
      `INSERT INTO marea_class_exchange_previews (${Object.keys(fields).join(",")}) VALUES (${Object.keys(
        fields,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(fields));
}

describe("governance constraints executed by real SQLite", () => {
  it("rejects a second active student class across centers, not merely a duplicate primary key", () => {
    membership("class-1", "center-1");
    expect(() => {
      membership("class-2", "center-2");
    }).toThrow(/UNIQUE constraint failed: marea_governance_memberships.user_id/u);
    expect(
      fixture.port.readAll(
        "SELECT class_id, center_id FROM marea_governance_memberships WHERE user_id = 'student-1'",
      ),
    ).toEqual([{ class_id: "class-1", center_id: "center-1" }]);
    // Negative control: with only this index removed, the same distinct-class write succeeds.
    fixture.database.exec("DROP INDEX marea_governance_one_student_class");
    expect(() => {
      membership("class-2", "center-2");
    }).not.toThrow();
  });

  it("permits multiple teacher classes and a new student class after explicit revocation", () => {
    membership("class-1", "center-1", "teacher-1", "teacher");
    membership("class-2", "center-2", "teacher-1", "teacher");
    membership("class-1", "center-1");
    fixture.database.exec(
      "UPDATE marea_governance_memberships SET state = 'revoked' WHERE user_id = 'student-1'",
    );
    membership("class-2", "center-2");
    expect(
      fixture.port.readOne("SELECT COUNT(*) AS count FROM marea_governance_memberships"),
    ).toEqual({ count: 4n });
  });

  it("enforces both composite membership foreign keys and state/role constraints", () => {
    expect(() => {
      membership("class-1", "center-2");
    }).toThrow(/FOREIGN KEY/u);
    expect(() => {
      membership("missing", "center-1");
    }).toThrow(/FOREIGN KEY/u);
    expect(() => {
      membership("class-1", "center-1", "missing");
    }).toThrow(/FOREIGN KEY/u);
    fixture.database.exec(
      "DELETE FROM marea_center_memberships WHERE center_id = 'center-2' AND user_id = 'student-1'",
    );
    expect(() => {
      membership("class-2", "center-2");
    }).toThrow(/FOREIGN KEY/u);
    expect(() => {
      membership("class-1", "center-1", "student-1", "administrator");
    }).toThrow(/CHECK/u);
    expect(() => {
      membership("class-1", "center-1", "student-1", "student", "pending");
    }).toThrow(/CHECK/u);
  });

  it("executes the declared STRICT and NO ACTION constraints without cascades", () => {
    const counts = {
      marea_centers: 0,
      marea_governance_accounts: 2,
      marea_center_memberships: 2,
      marea_governance_classes: 2,
      marea_governance_memberships: 4,
      marea_class_exchange_previews: 5,
      marea_governance_audit: 2,
    };
    for (const [table, count] of Object.entries(counts)) {
      expect(
        fixture.port.readOne("SELECT strict FROM pragma_table_list WHERE name = ?", [table]),
      ).toEqual({ strict: 1n });
      const keys = fixture.port.readAll(`PRAGMA foreign_key_list(${table})`);
      expect(keys).toHaveLength(count);
      for (const key of keys)
        expect(key).toMatchObject({ on_delete: "NO ACTION", on_update: "NO ACTION" });
    }
    expect(() => {
      fixture.database.exec("DELETE FROM marea_centers WHERE id = 'center-1'");
    }).toThrow(/FOREIGN KEY/u);
    expect(() => {
      fixture.database.exec("UPDATE marea_centers SET id = 'renamed' WHERE id = 'center-1'");
    }).toThrow(/FOREIGN KEY/u);
    expect(() => {
      fixture.database.exec("UPDATE marea_centers SET display_name = X'00' WHERE id = 'center-1'");
    }).toThrow(/TEXT/u);
    expect(fixture.port.readOne("SELECT COUNT(*) AS count FROM marea_centers")).toEqual({
      count: 2n,
    });
  });

  it("enforces account and center-association states, references and required fields", () => {
    for (const sql of [
      "UPDATE marea_governance_accounts SET state = 'revoked' WHERE user_id = 'teacher-1'",
      "UPDATE marea_governance_accounts SET owner_center_id = 'missing' WHERE user_id = 'teacher-1'",
      "UPDATE marea_governance_accounts SET version = NULL WHERE user_id = 'teacher-1'",
      "UPDATE marea_center_memberships SET capability = 'operator' WHERE user_id = 'teacher-1'",
      "UPDATE marea_center_memberships SET state = 'pending' WHERE user_id = 'teacher-1'",
      "UPDATE marea_governance_classes SET center_id = 'missing' WHERE class_id = 'class-1'",
    ])
      expect(() => {
        fixture.database.exec(sql);
      }).toThrow();
    for (const state of ["pending", "disabled", "active"]) {
      fixture.database
        .prepare("UPDATE marea_governance_accounts SET state = ? WHERE user_id = 'teacher-1'")
        .run(state);
      expect(
        fixture.port.readOne(
          "SELECT state FROM marea_governance_accounts WHERE user_id = 'teacher-1'",
        ),
      ).toEqual({ state });
    }
  });

  it("separates administrator session-bound previews from sessionless operator previews", () => {
    preview();
    preview({ id: "private-preview", authority: "operator", user_id: null, session_id: null });
    for (const fields of [
      { authority: "operator" },
      { user_id: null },
      { session_id: null },
      { user_id: null, session_id: null },
      { authority: "operator", user_id: null },
      { authority: "operator", session_id: null },
      { authority: "teacher" },
      { user_id: "missing" },
      { session_id: "missing" },
      { center_id: "center-2" },
      { expected_class_version: null },
      { operator_fingerprint: null },
      { package_digest: null },
    ])
      expect(() => {
        preview({ id: "invalid-preview", ...fields });
      }).toThrow();
    expect(
      fixture.port.readOne("SELECT COUNT(*) AS count FROM marea_class_exchange_previews"),
    ).toEqual({ count: 2n });
  });

  it("accepts only consistent preview payload, expiry and result states", () => {
    for (const fields of [
      { package_json: null },
      { settings_json: null },
      { result_revision_id: "revision-1" },
      { package_json: "{" },
      { settings_json: "{" },
      { expires_at: created },
      { expires_at: "2026-09-12T07:59:59.000Z" },
      { state: "unknown" },
      { state: "consumed" },
      { state: "cancelled" },
      { state: "expired" },
      { state: "consumed", package_json: null, settings_json: null, result_revision_id: null },
      { state: "consumed", package_json: null, settings_json: null, result_revision_id: "missing" },
      {
        state: "cancelled",
        package_json: null,
        settings_json: null,
        result_revision_id: "revision-1",
      },
      {
        state: "expired",
        package_json: null,
        settings_json: null,
        result_revision_id: "revision-1",
      },
    ])
      expect(() => {
        preview(fields);
      }).toThrow();
    preview();
    for (const state of ["consumed", "cancelled", "expired"])
      preview({
        id: `preview-${state}`,
        state,
        package_json: null,
        settings_json: null,
        result_revision_id: state === "consumed" ? "revision-1" : null,
      });
    expect(
      fixture.port.readOne("SELECT COUNT(*) AS count FROM marea_class_exchange_previews"),
    ).toEqual({ count: 4n });
    expect(
      fixture.port.readOne(
        "SELECT configuration_json FROM marea_class_teaching_revisions WHERE id = 'revision-1'",
      ),
    ).toEqual({ configuration_json: "{}" });
  });

  it("records an account actor only for administrator audit rows", () => {
    const insert = (authority: string, user: string | null) => {
      fixture.database
        .prepare(
          "INSERT INTO marea_governance_audit (request_id, actor_user_id, authority, center_id, operation, target_id, result_version, occurred_at) VALUES ('req-1', ?, ?, 'center-1', 'test', 'class-1', 'v1', ?)",
        )
        .run(user, authority, created);
    };
    insert("administrator", "teacher-1");
    insert("operator", null);
    expect(() => {
      insert("administrator", null);
    }).toThrow(/CHECK/u);
    expect(() => {
      insert("operator", "teacher-1");
    }).toThrow(/CHECK/u);
    expect(() => {
      insert("student", "student-1");
    }).toThrow(/CHECK/u);
    expect(() => {
      insert("administrator", "missing");
    }).toThrow(/FOREIGN KEY/u);
    expect(fixture.port.readOne("SELECT COUNT(*) AS count FROM marea_governance_audit")).toEqual({
      count: 2n,
    });
  });
});
