import { afterEach, beforeEach, expect, it } from "vitest";
import {
  profileHarness,
  release,
  selected,
  schemas,
  request,
  write,
  teacher,
  classScope,
} from "./profile.fixture.js";
let h: ReturnType<typeof profileHarness>;
beforeEach(() => {
  h = profileHarness();
});
afterEach(() => {
  h.database.close();
});
it("persists independent teachers, whole-field overrides and explicit empty layouts", () => {
  expect(h.read()).toMatchObject({
    personal: { revision: null, status: "default" },
    override: null,
    effective: release.defaults,
  });
  const personal = schemas.state.parse(h.execute("save", write()));
  expect(personal.personal).toMatchObject({
    revision: "profile-1",
    status: "valid",
    value: release.defaults,
  });
  h.execute(
    "save",
    write({ scope: classScope, expectedPersonalRevision: "profile-1", value: { modules: [] } }),
  );
  expect(h.read(classScope).effective).toEqual({ ...release.defaults, modules: [] });
  expect(h.read(classScope, { ...teacher, userId: "teacher-2" }).personal.revision).toBeNull();
  expect(h.read(classScope, { ...teacher, userId: "teacher-2" }).effective).toEqual(
    release.defaults,
  );
  h.execute(
    "reset",
    request("reset", {
      scope: classScope,
      expectedRevision: "profile-2",
      expectedPersonalRevision: "profile-1",
      catalogRevision: release.revision,
    }),
  );
  expect(h.read(classScope)).toMatchObject({
    override: { revision: "profile-3", status: "default", value: null },
    effective: release.defaults,
  });
});
it("rejects stale scope, personal and release revisions and reset ABA", () => {
  h.execute("save", write());
  expect(() => h.execute("save", write())).toThrow();
  expect(() => h.execute("save", write({ scope: classScope, value: { modules: [] } }))).toThrow();
  expect(() =>
    h.execute(
      "save",
      write({
        expectedRevision: "profile-1",
        expectedPersonalRevision: "profile-1",
        catalogRevision: "b".repeat(64),
      }),
    ),
  ).toThrow();
  h.runtime.catalogRevision = "b".repeat(64);
  expect(() =>
    h.execute(
      "reset",
      request("reset", {
        expectedRevision: "profile-1",
        expectedPersonalRevision: "profile-1",
        catalogRevision: release.revision,
      }),
    ),
  ).toThrow();
  h.runtime.catalogRevision = release.revision;
  h.execute(
    "reset",
    request("reset", {
      expectedRevision: "profile-1",
      expectedPersonalRevision: "profile-1",
      catalogRevision: release.revision,
    }),
  );
  expect(h.read().personal.revision).toBe("profile-2");
  expect(() => h.execute("save", write())).toThrow();
  h.execute(
    "save",
    write({ expectedRevision: "profile-2", expectedPersonalRevision: "profile-2" }),
  );
  expect(h.read().personal.revision).toBe("profile-3");
});
it("readback reconciles an uncertain committed save without replay", () => {
  h.execute("save", write());
  const readback = h.read();
  expect(readback.personal.value).toEqual(release.defaults);
  expect(readback.personal.revision).toBe("profile-1");
  expect(() => h.execute("save", write())).toThrow();
  expect(h.read().personal.revision).toBe("profile-1");
});
it("rechecks current membership, role and permissions without granting catalog authority", () => {
  h.runtime.permitted = false;
  expect(h.read().effective.modules).toEqual([]);
  expect(h.execute("catalog", request("catalog"))).toMatchObject({
    modules: [],
    releaseDefaults: { modules: [] },
  });
  expect(() => h.execute("save", write())).toThrow();
  h.runtime.permitted = true;
  h.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 'teacher-1'");
  expect(() => h.read(classScope)).toThrow();
  expect(() => h.execute("save", write({ scope: classScope, value: { modules: [] } }))).toThrow();
  expect(() => h.read(undefined, { ...teacher, role: "student" })).toThrow();
});
it("personal reset preserves class overrides and disabled selections stay editable", () => {
  h.execute(
    "save",
    write({ value: { ...release.defaults, modules: [{ ...selected, enabled: false }] } }),
  );
  expect(h.read().effective.modules).toEqual([]);
  expect(h.read().personal.value?.modules[0]?.enabled).toBe(false);
  h.execute(
    "save",
    write({
      scope: classScope,
      expectedPersonalRevision: "profile-1",
      value: { themeId: release.defaults.themeId },
    }),
  );
  h.execute(
    "reset",
    request("reset", {
      expectedRevision: "profile-1",
      expectedPersonalRevision: "profile-1",
      catalogRevision: release.revision,
    }),
  );
  expect(h.read(classScope)).toMatchObject({
    personal: { revision: "profile-3" },
    override: {
      revision: "profile-2",
      status: "valid",
      value: { themeId: release.defaults.themeId },
    },
    effective: release.defaults,
  });
});
it("rolls back a failed write and retains the request correlation ID", () => {
  h.database.execute(
    "CREATE TRIGGER profile_failure BEFORE INSERT ON marea_dashboard_profiles BEGIN SELECT RAISE(ABORT, 'private failure'); END",
  );
  expect(() => h.execute("save", write())).toThrow(
    expect.objectContaining({ status: 500, requestId: "profile-request" }),
  );
  expect(h.read().personal.revision).toBeNull();
});
it("returns complete stable state envelopes for never-written teacher and class scopes", () => {
  const empty = { revision: null, updatedAt: null, status: "default", value: null };
  const expected = {
    protocolVersion: "0.1",
    requestId: "profile-request",
    kind: "dashboard-profile-state",
    schemaVersion: 1,
    generatedAt: "2026-09-22T12:00:00Z",
    catalogRevision: release.revision,
    personal: empty,
    effective: release.defaults,
    warnings: [],
  };
  expect(h.read()).toEqual({ ...expected, scope: { kind: "teacher" }, override: null });
  expect(h.read(classScope)).toEqual({ ...expected, scope: classScope, override: empty });
  expect(h.execute("catalog", request("catalog"))).toEqual({
    protocolVersion: "0.1",
    requestId: "profile-request",
    kind: "dashboard-profile-catalog-result",
    scope: { kind: "teacher" },
    catalogRevision: release.revision,
    modules: release.modules,
    themes: release.themes,
    releaseDefaults: release.defaults,
  });
});
it("accepts a second ordinary save and checks the selected class revision independently", () => {
  h.execute("save", write());
  h.execute(
    "save",
    write({
      expectedRevision: "profile-1",
      expectedPersonalRevision: "profile-1",
      value: { ...release.defaults, modules: [] },
    }),
  );
  expect(h.read().personal.revision).toBe("profile-2");
  h.execute(
    "save",
    write({ scope: classScope, expectedPersonalRevision: "profile-2", value: { modules: [] } }),
  );
  expect(() =>
    h.execute(
      "save",
      write({
        scope: classScope,
        expectedRevision: null,
        expectedPersonalRevision: "profile-2",
        value: { modules: [] },
      }),
    ),
  ).toThrow(expect.objectContaining({ status: 409 }));
  h.execute(
    "save",
    write({
      scope: classScope,
      expectedRevision: "profile-3",
      expectedPersonalRevision: "profile-2",
      value: { modules: [selected] },
    }),
  );
  expect(h.read(classScope).effective.modules).toEqual([selected]);
});
it("checks governance revocation inside the profile transaction", () => {
  h.database.execute("INSERT INTO marea_centers VALUES ('center','Synthetic','v1','now','now')");
  h.database.execute(
    "INSERT INTO marea_governance_accounts VALUES ('teacher-1','center','disabled','v1','now','now')",
  );
  expect(() => h.execute("save", write())).toThrow(expect.objectContaining({ status: 403 }));
  expect(h.store.read("teacher-1", null)).toBeNull();
});
