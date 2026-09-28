import assert from "node:assert/strict";

/** Real HTTP transactions under the second teacher; no intercepted profile responses. */
export async function releaseProfileHttp(page, post) {
  const personal = { kind: "teacher" };
  const scope = { kind: "class", classId: "class:ready" };
  const read = (selected) =>
    post(page, "profiles/read", { kind: "dashboard-profile-read", scope: selected });
  const save = (state, selected, value) =>
    post(page, "profiles/save", {
      kind: "dashboard-profile-save",
      scope: selected,
      expectedRevision: (state.override ?? state.personal).revision,
      expectedPersonalRevision: state.personal.revision,
      catalogRevision: state.catalogRevision,
      discardUnavailable: false,
      value,
    });
  const reset = (state, selected) =>
    post(page, "profiles/reset", {
      kind: "dashboard-profile-reset",
      scope: selected,
      expectedRevision: (state.override ?? state.personal).revision,
      expectedPersonalRevision: state.personal.revision,
      catalogRevision: state.catalogRevision,
    });
  const original = (await read(personal)).body;
  const personalSaved = await save(original, personal, {
    ...original.effective,
    themeId: "org.marea.theme.high-contrast",
  });
  assert.equal(personalSaved.status, 200);
  const inherited = (await read(scope)).body;
  assert.equal(inherited.effective.themeId, "org.marea.theme.high-contrast");
  const empty = await save(inherited, scope, { modules: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.effective.modules, []);
  assert.equal(empty.body.effective.themeId, "org.marea.theme.high-contrast");
  const personalReset = await reset(personalSaved.body, personal);
  assert.equal(personalReset.status, 200);
  const afterReset = (await read(scope)).body;
  assert.deepEqual(afterReset.override.value, { modules: [] });
  assert.deepEqual(afterReset.effective.modules, []);
  assert.equal(afterReset.effective.themeId, "org.marea.theme.marea");
  assert.equal(
    (await save(empty.body, scope, { themeId: "org.marea.theme.marea" })).status,
    409,
    "inherited revision race",
  );
  const cleared = await reset(afterReset, scope);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.override.value, null);
  assert.notEqual(cleared.body.override.revision, afterReset.override.revision);
  const recreated = await save(cleared.body, scope, { modules: [] });
  assert.equal(recreated.status, 200);
  assert.equal(
    (await reset(afterReset, scope)).status,
    409,
    "reset/recreate cannot reuse old revision",
  );
  const forbidden = { ...scope, classId: "class:foreign" };
  assert.equal((await save(recreated.body, forbidden, { modules: [] })).status, 403);
  assert.equal((await reset(recreated.body, forbidden)).status, 403);
  assert.equal(
    (
      await post(page, "profiles/read", {
        kind: "dashboard-profile-read",
        scope: personal,
        userId: "user:teacher",
      })
    ).status,
    400,
    "identity cannot be supplied by caller",
  );
}
