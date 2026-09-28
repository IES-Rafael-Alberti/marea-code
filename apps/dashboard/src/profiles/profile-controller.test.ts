import { expect, it, vi } from "vitest";
import { ProfileController } from "./profile-controller.js";
import { ProfileRequestError, LegacyProfileModeError } from "./profile-client.boundary.js";
import { catalog, clientFixture, release, state, value } from "./profile.fixture.js";

it("edits personal defaults and whole-field class overrides with both revisions", async () => {
  const client = clientFixture();
  const changed = vi.fn();
  const c = new ProfileController(client, release, changed);
  await c.write();
  await c.select({ kind: "teacher" });
  expect(c.draft).toEqual(value);
  c.edit({ ...value, modules: [] });
  await c.write();
  expect(client.save).toHaveBeenCalledWith(
    {
      scope: { kind: "teacher" },
      expectedRevision: null,
      expectedPersonalRevision: null,
      catalogRevision: release.revision,
    },
    { ...value, modules: [] },
    false,
    expect.any(AbortSignal),
  );
  await c.select({ kind: "class", classId: "class:a" });
  expect(c.draft).toEqual({});
  await c.write();
  expect(c.problem).toBe("invalid");
  c.edit({ modules: [] });
  expect(c.problem).toBeNull();
  await c.write();
  expect(client.save.mock.lastCall?.[1]).toEqual({ modules: [] });
  c.dispose();
  c.edit(value);
  await c.write();
  await c.read();
  expect(client.save).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalled();
});
it("preserves drafts on conflicts, reads current state and requires explicit reconciliation", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  c.reconcile(true);
  await c.select({ kind: "teacher" });
  c.edit({ ...value, modules: [] });
  client.save.mockRejectedValue(new ProfileRequestError(409));
  await c.write();
  expect(c.problem).toBe("conflict");
  expect(c.draft?.modules).toEqual([]);
  expect(c.recovery).toEqual(state());
  expect(c.matched).toBe(false);
  await c.write();
  expect(client.save).toHaveBeenCalledTimes(1);
  c.reconcile(true);
  expect(c.problem).toBeNull();
  expect(c.dirty).toBe(true);
  await c.select({ kind: "class", classId: "class:a" });
  c.edit({ themeId: "org.marea.theme.high-contrast" });
  await c.select({ kind: "teacher" });
  expect(c.draft?.modules).toEqual([]);
  expect(c.recovery).not.toBeNull();
  c.reconcile(false);
  expect(c.draft).toEqual(value);
  expect(c.dirty).toBe(false);
});
it("reads back uncertain writes without replay and compares normalized values", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.select({ kind: "teacher" });
  c.edit(value);
  client.save.mockRejectedValue(new Error("lost"));
  const saved = {
    ...state(),
    personal: {
      revision: "r:1",
      updatedAt: "2026-09-22T10:00:00.000Z",
      status: "valid" as const,
      value,
    },
  };
  client.read.mockResolvedValue(saved);
  await c.write();
  expect(c.problem).toBe("uncertain");
  expect(c.matched).toBe(true);
  expect(client.save).toHaveBeenCalledTimes(1);
  c.reconcile(false);
  expect(c.current).toEqual(saved);
  expect(c.problem).toBeNull();
});
it("blocks mismatched catalogs while retaining the draft and allows corrupt-scope reset only", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.select({ kind: "teacher" });
  c.edit(value);
  client.read.mockResolvedValue({ ...state(), catalogRevision: "a".repeat(64) });
  await c.read();
  expect(c.problem).toBe("catalog");
  c.reconcile(false);
  await c.write();
  expect(client.save).not.toHaveBeenCalled();
  client.read.mockResolvedValue(state());
  client.catalog.mockResolvedValue({ ...catalog(), catalogRevision: "b".repeat(64) });
  await c.read();
  expect(c.problem).toBe("catalog");
  expect(c.draft).toEqual(value);
  client.catalog.mockResolvedValue(catalog());
  client.read.mockResolvedValue({
    ...state(),
    personal: {
      revision: "r:broken",
      updatedAt: "2026-09-22T10:00:00.000Z",
      status: "recovery-required",
      value: null,
    },
  });
  const recovery = new ProfileController(client, release, vi.fn());
  await recovery.read();
  expect(recovery.problem).toBe("recovery");
  await recovery.write();
  expect(client.save).not.toHaveBeenCalled();
  await recovery.write(true);
  expect(client.reset.mock.lastCall?.[0].expectedRevision).toBe("r:broken");
  expect(recovery.problem).toBeNull();
});
it("isolates late scope reads and writes after cancellation and suppresses simultaneous operations", async () => {
  const client = clientFixture();
  const changed = vi.fn();
  const c = new ProfileController(client, release, changed);
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.read.mockReturnValueOnce(pending.promise);
  const read = c.read();
  await c.read();
  c.edit(value);
  await c.write();
  expect(c.draft).toBeNull();
  expect(client.read).toHaveBeenCalledTimes(1);
  await c.select({ kind: "class", classId: "class:b" });
  pending.resolve(state());
  await read;
  expect(c.current?.scope).toEqual({ kind: "class", classId: "class:b" });
  c.edit({ modules: [] });
  const write = Promise.withResolvers<ReturnType<typeof state>>();
  client.save.mockReturnValue(write.promise);
  const saving = c.write();
  const signal = client.save.mock.lastCall?.[3];
  c.dispose();
  const calls = changed.mock.calls.length;
  write.resolve(state());
  await saving;
  expect(signal?.aborted).toBe(true);
  expect(changed).toHaveBeenCalledTimes(calls);
});
it("handles read failure, late rejected operations, reset uncertainty and mismatched write results", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  client.read.mockRejectedValueOnce(new Error("offline"));
  await c.read();
  expect(c.problem).toBe("unavailable");
  await c.read();
  expect(c.problem).toBeNull();
  client.save.mockResolvedValue({ ...state(), catalogRevision: "c".repeat(64) });
  await c.write();
  expect(c.problem).toBe("catalog");
  await c.select({ kind: "teacher" });
  client.reset.mockRejectedValue(new Error("offline"));
  await c.write(true);
  expect(c.problem).toBe("uncertain");
  expect(client.reset).toHaveBeenCalledTimes(1);
  const late = Promise.withResolvers<ReturnType<typeof state>>();
  client.read.mockReturnValue(late.promise);
  const reading = c.select({ kind: "teacher" });
  c.dispose();
  late.reject(new Error("cancelled"));
  await reading;
});
it("retains a readback draft even if the response arrives after disposal, including rejected writes", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.read();
  c.edit(value);
  client.save.mockRejectedValueOnce(new ProfileRequestError(503));
  await c.write();
  expect(c.problem).toBe("uncertain");
  c.reconcile(false);
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.save.mockReturnValue(pending.promise);
  const saving = c.write();
  c.dispose();
  pending.reject(new Error("late"));
  await saving;
  expect(c.problem).toBeNull();
  const empty = new ProfileController(clientFixture(), release, vi.fn());
  empty.catalog = catalog();
  await empty.write();
  expect(empty.current).toBeNull();
  empty.recovery = state();
  empty.catalog = null;
  empty.reconcile(false);
  expect(empty.draft).toEqual(value);
});
it("ignores a reset confirmation after the editor is disposed", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.read();
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.reset.mockReturnValue(pending.promise);
  const before = c.current;
  const resetting = c.write(true);
  expect(c.busy).toBe(true);
  c.dispose();
  pending.resolve({
    ...state(),
    personal: {
      revision: "revision:late",
      updatedAt: "2026-09-22T00:00:00.000Z",
      status: "default",
      value: null,
    },
  });
  await resetting;
  expect(c.current).toBe(before);
  expect(c.busy).toBe(true);
});
it("publishes loading/edit/write transitions and locks concurrent writes", async () => {
  const client = clientFixture();
  const snapshots: { busy: boolean; dirty: boolean; problem: string | null }[] = [];
  const c = new ProfileController(client, release, () => {
    snapshots.push({ busy: c.busy, dirty: c.dirty, problem: c.problem });
  });
  expect(c.matched).toBe(false);
  expect(c.discardUnavailable).toBe(false);
  expect(c.dirty).toBe(false);
  await c.read();
  expect(snapshots).toEqual([
    { busy: true, dirty: false, problem: null },
    { busy: false, dirty: false, problem: null },
  ]);
  snapshots.length = 0;
  c.edit({ ...value, modules: [] });
  expect(snapshots).toEqual([{ busy: false, dirty: true, problem: null }]);
  snapshots.length = 0;
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.save.mockReturnValueOnce(pending.promise);
  const saving = c.write();
  expect(snapshots).toEqual([{ busy: true, dirty: true, problem: null }]);
  await c.write();
  expect(client.save).toHaveBeenCalledOnce();
  c.edit(value);
  expect(c.draft?.modules).toEqual([]);
  pending.resolve(state());
  await saving;
  expect(snapshots.at(-1)).toEqual({ busy: false, dirty: false, problem: null });
  c.catalog = null;
  await c.write();
  expect(client.save).toHaveBeenCalledOnce();
  c.catalog = catalog();
  c.dispose();
  await c.write();
  expect(client.save).toHaveBeenCalledOnce();
});
it("checks distinct personal/class revisions and saves only normalized whole-field drafts", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  const scope = { kind: "class", classId: "class:a" } as const;
  const classState = {
    ...state(scope),
    personal: {
      revision: "personal:1",
      updatedAt: "2026-09-22T00:00:00.000Z",
      status: "valid" as const,
      value,
    },
    override: {
      revision: "class:2",
      updatedAt: "2026-09-22T00:00:00.000Z",
      status: "valid" as const,
      value: { modules: [] },
    },
  };
  client.read.mockResolvedValue(classState);
  await c.select(scope);
  expect(c.draft).toEqual({ modules: [] });
  c.discardUnavailable = true;
  await c.write();
  expect(client.save.mock.lastCall?.slice(0, 3)).toEqual([
    {
      scope,
      expectedRevision: "class:2",
      expectedPersonalRevision: "personal:1",
      catalogRevision: release.revision,
    },
    { modules: [] },
    true,
  ]);
  await c.select({ kind: "teacher" });
  c.edit({ modules: [] });
  await c.write();
  expect(c.problem).toBe("invalid");
  expect(client.save).toHaveBeenCalledOnce();
});
it("preserves conflict and unavailable drafts through reconciliation and scope caching", async () => {
  const client = clientFixture();
  const changed = vi.fn();
  const c = new ProfileController(client, release, changed);
  await c.read();
  await c.select({ kind: "class", classId: "class:a" });
  c.edit({ modules: [] });
  await c.select({ kind: "teacher" });
  expect(c.dirty).toBe(false);
  expect(c.discardUnavailable).toBe(false);
  await c.select({ kind: "class", classId: "class:a" });
  expect(c.draft).toEqual({ modules: [] });
  c.recovery = state(c.scope);
  c.problem = "catalog";
  c.reconcile(false);
  expect(c.recovery).not.toBeNull();
  expect(c.draft).toEqual({ modules: [] });
  c.problem = null;
  c.draft = null;
  c.reconcile(true);
  expect(c.draft).toEqual({});
  c.edit({ modules: [] });
  client.read.mockRejectedValueOnce(new Error("offline"));
  await c.read();
  expect(c.problem).toBe("unavailable");
  expect(c.draft).toEqual({ modules: [] });
  const count = changed.mock.calls.length;
  c.dispose();
  await c.read();
  c.edit(value);
  expect(changed).toHaveBeenCalledTimes(count);
  await c.select({ kind: "class", classId: "class:b" });
  await c.select({ kind: "class", classId: "class:a" });
  expect(c.draft).toEqual({});
});
it("blocks catalog mismatch errors without losing an edited profile", async () => {
  const { ProfileCatalogMismatchError } = await import("./profile-client.boundary.js");
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.read();
  c.edit(value);
  client.save.mockRejectedValue(new ProfileCatalogMismatchError());
  await c.write();
  expect(c.problem).toBe("catalog");
  expect(c.draft).toEqual(value);
  client.read.mockRejectedValue(new ProfileCatalogMismatchError());
  await c.read();
  expect(c.problem).toBe("catalog");
  expect(c.draft).toEqual(value);
});
it("does not cache clean scopes and removes cached drafts after accepting current state", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  const scope = { kind: "class", classId: "class:a" } as const;
  await c.select(scope);
  c.discardUnavailable = true;
  await c.select({ kind: "teacher" });
  expect(c.discardUnavailable).toBe(false);
  await c.select(scope);
  expect(c.dirty).toBe(false);
  expect(c.recovery).toBeNull();
  c.edit({ modules: [] });
  await c.select({ kind: "teacher" });
  await c.select(scope);
  c.reconcile(false);
  await c.select({ kind: "teacher" });
  await c.select(scope);
  expect(c.draft).toEqual({});
  expect(c.dirty).toBe(false);
  c.edit({ modules: [] });
  await c.select({ kind: "teacher" });
  c.dispose();
  expect(c.dirty).toBe(false);
  expect(c.draft).toBeNull();
  await c.select(scope);
  expect(c.draft).toEqual({});
  expect(c.recovery).toBeNull();
});
it("refuses catalog-only changes and keeps reset conflicts without requiring an edited draft", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  client.catalog.mockResolvedValueOnce({ ...catalog(), catalogRevision: "d".repeat(64) });
  await c.read();
  expect(c.problem).toBe("catalog");
  expect(c.current).toBeNull();
  await c.write(true);
  expect(client.reset).not.toHaveBeenCalled();
  await c.select({ kind: "teacher" });
  client.reset.mockRejectedValue(new ProfileRequestError(409));
  await c.write(true);
  expect(c.problem).toBe("conflict");
  expect(c.recovery).toEqual(state());
  expect(c.dirty).toBe(false);
  c.edit(value);
  expect(c.problem).toBe("conflict");
  await c.write(true);
  expect(client.reset).toHaveBeenCalledOnce();
});
it("publishes invalid and reconciliation states and isolates rejected reads after cancellation", async () => {
  const client = clientFixture();
  const changed = vi.fn();
  const c = new ProfileController(client, release, changed);
  await c.read();
  c.edit({ modules: [] });
  changed.mockClear();
  await c.write();
  expect(changed).toHaveBeenCalledOnce();
  expect(c.problem).toBe("invalid");
  c.recovery = state();
  changed.mockClear();
  c.reconcile(false);
  expect(changed).toHaveBeenCalledOnce();
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.read.mockReturnValueOnce(pending.promise);
  const reading = c.read();
  c.dispose();
  const calls = changed.mock.calls.length;
  pending.reject(new Error("cancelled"));
  await reading;
  expect(c.problem).toBeNull();
  expect(changed).toHaveBeenCalledTimes(calls);
});
it("requires class recovery reset independently of the valid personal scope", async () => {
  const client = clientFixture();
  const scope = { kind: "class", classId: "class:a" } as const;
  const broken = {
    ...state(scope),
    override: {
      revision: "class:bad",
      updatedAt: "2026-09-22T00:00:00.000Z",
      status: "recovery-required" as const,
      value: null,
    },
  };
  client.read.mockResolvedValue(broken);
  const c = new ProfileController(client, release, vi.fn());
  await c.select(scope);
  expect(c.problem).toBe("recovery");
  await c.write();
  expect(client.save).not.toHaveBeenCalled();
  await c.write(true);
  expect(client.reset.mock.lastCall?.[0].expectedRevision).toBe("class:bad");
});
it("clears unavailable-setting consent before a different scope finishes loading", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  await c.read();
  c.discardUnavailable = true;
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.read.mockReturnValueOnce(pending.promise);
  const selecting = c.select({ kind: "class", classId: "class:b" });
  expect(c.discardUnavailable).toBe(false);
  pending.reject(new Error("offline"));
  await selecting;
  expect(c.discardUnavailable).toBe(false);
});

it("clears legacy mode on a new scope and on a successful profile read", async () => {
  const client = clientFixture();
  const c = new ProfileController(client, release, vi.fn());
  expect(c.legacy).toBe(false);
  client.read.mockRejectedValueOnce(new LegacyProfileModeError());
  await c.select({ kind: "teacher" });
  expect(c.legacy).toBe(true);
  expect(c.catalog).toBeNull();
  await c.write();
  expect(client.save).not.toHaveBeenCalled();
  await c.read();
  expect(c.legacy).toBe(false);
  client.read.mockRejectedValueOnce(new LegacyProfileModeError());
  await c.read();
  expect(c.legacy).toBe(true);
  const pending = Promise.withResolvers<ReturnType<typeof state>>();
  client.read.mockReturnValueOnce(pending.promise);
  const selecting = c.select({ kind: "class", classId: "class:a" });
  expect(c.legacy).toBe(false);
  pending.reject(new ProfileRequestError(503));
  await selecting;
  expect(c.legacy).toBe(false);
});
