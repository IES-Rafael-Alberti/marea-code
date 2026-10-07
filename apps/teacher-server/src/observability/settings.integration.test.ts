import { expect, it, vi } from "vitest";
import { ObservabilitySettingsService } from "./settings.boundary.js";
import { observabilityFixture, encode, completeTurn } from "./observability.fixture.js";
import { student, clock } from "../../test-support/teaching-integration.fixture.js";
import {
  prepareTraceConnection,
  projectTraceSettings,
  nextTraceConfiguration,
} from "./settings-connections.js";

it("requires server administrator access and closed inputs without exposing secret values", async () => {
  const f = observabilityFixture();
  try {
    const read = () => f.service.execute(f.teacher, encode({ operation: "read" }));
    expect(await read()).toMatchObject({
      enabled: false,
      pluginId: null,
      status: { available: false, sent: 0, pending: 0 },
    });
    for (const actor of [student, { ...f.teacher, userId: "other" }])
      await expect(f.service.execute(actor, encode({ operation: "read" }))).rejects.toMatchObject({
        status: 403,
      });
    for (const input of [
      new Uint8Array([0xff]),
      encode({ operation: "bad" }),
      encode({ operation: "read", extra: true }),
    ])
      await expect(f.service.execute(f.teacher, input)).rejects.toMatchObject({ status: 400 });
    const saved = await f.save();
    expect(saved).toMatchObject({
      revision: 1,
      enabled: true,
      plugins: [
        {
          id: f.entry.manifest.id,
          values: { endpoint: "https://collector.test" },
          secrets: ["secret"],
        },
      ],
    });
    expect(JSON.stringify(saved)).not.toContain("synthetic-key");
    await expect(f.save({ expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    for (const values of [{ extra: "bad" }, { endpoint: "invalid" }, { secret: "" }])
      await expect(f.save({ values })).rejects.toMatchObject({ status: 400 });
    const initial = f.store.read()?.observability;
    await f.save({ values: { endpoint: "https://collector.test" } });
    expect(f.store.read()?.observability).toEqual(initial);
    await f.save({ values: { endpoint: "https://another.test" } });
    expect(f.store.read()?.observability?.namespace).toBe(initial?.namespace);
    expect(f.store.read()?.observability?.epoch).not.toBe(initial?.epoch);
    await expect(f.save({ pluginId: "absent" })).rejects.toMatchObject({ status: 400 });
  } finally {
    f.database.close();
  }
});
it("tests synthetic content without activating delivery and handles cancellation/failure safely", async () => {
  const f = observabilityFixture();
  try {
    const request = encode({
      operation: "test",
      pluginId: f.entry.manifest.id,
      values: { secret: "synthetic-key" },
    });
    expect(await f.service.execute(f.teacher, request)).toEqual({ accepted: true });
    expect(f.traces[0]?.spans[0]).toMatchObject({
      name: "Marea connection test",
      metadata: { synthetic: true },
      input: "Synthetic connection test. No student data.",
    });
    expect(f.store.read()?.observability).toBeUndefined();
    await expect(f.service.execute(f.teacher, request, AbortSignal.abort())).rejects.toMatchObject({
      status: 502,
    });
    f.fail(new Error("private error"));
    await expect(f.service.execute(f.teacher, request)).rejects.toMatchObject({ status: 502 });
    await expect(
      f.service.execute(f.teacher, encode({ operation: "test", pluginId: "removed", values: {} })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(f.save({ values: {} })).rejects.toMatchObject({ status: 400 });
  } finally {
    f.database.close();
  }
});
it("retains private settings on plugin removal, allows disabling and retries only on explicit action", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    completeTurn(f.database);
    f.fail(new Error("temporary"));
    await f.runtime.tick();
    const retry = vi.spyOn(f.runtime.queue, "retry");
    await f.service.execute(f.teacher, encode({ operation: "retry" }));
    expect(retry).toHaveBeenCalledWith(clock.now());
    expect(f.database.readOne("SELECT attempts,last_error FROM marea_trace_outbox")).toEqual({
      attempts: 0n,
      last_error: null,
    });
    f.catalog.length = 0;
    for (const q of [
      { enabled: true, values: {} },
      { enabled: false, values: { secret: "anything" } },
      { pluginId: "elsewhere", enabled: false, values: {} },
    ])
      await expect(f.save(q)).rejects.toMatchObject({ status: 400 });
    expect(await f.save({ enabled: false, values: {} })).toMatchObject({
      enabled: false,
      plugins: [],
      status: { available: false, pending: 0 },
    });
    expect(f.store.read()?.observability?.values.secret).toBe("synthetic-key");
  } finally {
    f.database.close();
  }
});
it("handles optional fields, missing stores and catalogs with non-executable entries", async () => {
  const f = observabilityFixture();
  try {
    const implementation = f.entry.traces;
    if (!implementation) throw new Error("fixture");
    const optional = {
      ...implementation,
      settings: {
        ...implementation.settings,
        fields: [
          {
            key: "optional",
            kind: "text" as const,
            required: false,
            label: { es: "O", en: "O", eu: "O" },
          },
        ],
      },
    };
    expect(prepareTraceConnection(optional, {}, undefined).values).toStrictEqual({});
    expect(prepareTraceConnection(optional, { optional: "text" }, undefined).values).toEqual({
      optional: "text",
    });
    const current = f.store.read();
    if (!current) throw new Error("fixture");
    expect(projectTraceSettings(current, [{ manifest: f.entry.manifest }], {})).toMatchObject({
      plugins: [],
    });
    const empty = new ObservabilitySettingsService(
      { read: () => null, write: () => undefined },
      f.catalog,
      f.runtime,
      clock,
      "test",
    );
    await expect(empty.execute(f.teacher, encode({ operation: "read" }))).rejects.toMatchObject({
      status: 403,
    });
    vi.spyOn(f.store, "read").mockReturnValueOnce(current).mockReturnValueOnce(null);
    await expect(f.service.execute(f.teacher, encode({ operation: "read" }))).rejects.toMatchObject(
      { status: 503 },
    );
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});

it("isolates destination credentials, preserves queue identity on secret rotation and never retries during reads", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    const first = f.store.read()?.observability;
    if (!first) throw new Error("fixture");
    expect(first.namespace).toMatch(/^[a-f0-9-]{36}$/u);
    const retry = vi.spyOn(f.runtime.queue, "retry");
    await f.service.execute(f.teacher, encode({ operation: "read" }));
    expect(retry).not.toHaveBeenCalled();
    await f.save({ values: { secret: "replacement-key" } });
    expect(f.store.read()?.observability).toEqual({
      ...first,
      values: { ...first.values, secret: "replacement-key" },
    });
    // Omitting a public field uses its default rather than resurrecting a previously saved value.
    await f.save({ values: { endpoint: "https://different.test" } });
    await f.save({ values: {} });
    expect(f.store.read()?.observability?.values.endpoint).toBe("https://collector.test");
    const second = { ...f.entry, manifest: { ...f.entry.manifest, id: "org.marea.second" } };
    f.catalog.push(second);
    await expect(f.save({ pluginId: second.manifest.id, values: {} })).rejects.toMatchObject({
      status: 400,
    });
    await f.save({ pluginId: second.manifest.id, values: { secret: "second-key" } });
    expect(f.store.read()?.observability?.namespace).toBe(first.namespace);
    expect(f.store.read()?.observability?.values.secret).toBe("second-key");
    f.catalog.length = 0;
    const revision = f.store.read()?.revision;
    expect(
      await f.save({ pluginId: second.manifest.id, enabled: false, values: {} }),
    ).toMatchObject({ revision: Number(revision) + 1, enabled: false });
    await expect(
      f.service.execute(
        f.teacher,
        encode({ operation: "test", pluginId: second.manifest.id, values: {} }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});
it("rejects a non-teacher even if mistakenly listed as administrator and rejects malformed UTF-8 inside valid JSON", async () => {
  const f = observabilityFixture();
  try {
    const current = f.store.read();
    if (!current) throw new Error("fixture");
    f.store.write(
      { ...current, administrators: [f.teacher.userId, student.userId] },
      current.revision,
    );
    await expect(f.service.execute(student, encode({ operation: "read" }))).rejects.toMatchObject({
      status: 403,
    });
    const prefix = new TextEncoder().encode(
      '{"operation":"test","pluginId":"org.marea.synthetic","values":{"secret":"',
    );
    const suffix = new TextEncoder().encode('"}}');
    await expect(
      f.service.execute(f.teacher, new Uint8Array([...prefix, 0xff, ...suffix])),
    ).rejects.toMatchObject({ status: 400 });
    f.catalog.length = 0;
    await expect(f.save({ enabled: false, values: {} })).rejects.toMatchObject({ status: 400 });
  } finally {
    f.database.close();
  }
});
it("compares every public destination field and omits absent values from its public projection", () => {
  const f = observabilityFixture();
  try {
    const implementation = f.entry.traces;
    const current = f.store.read();
    if (!implementation || !current) throw new Error("fixture");
    const fields = ["region", "tenant"].map((key) => ({
      key,
      kind: "text" as const,
      required: false,
      label: { es: key, en: key, eu: key },
    }));
    const entry = {
      ...f.entry,
      traces: { ...implementation, settings: { ...implementation.settings, fields } },
    };
    const connection = prepareTraceConnection(
      entry.traces,
      { region: "west", tenant: "classroom" },
      undefined,
    );
    const previous = nextTraceConfiguration(entry.manifest.id, true, connection, undefined);
    expect(nextTraceConfiguration(entry.manifest.id, true, connection, previous).epoch).toBe(
      previous.epoch,
    );
    for (const values of [
      { region: "east", tenant: "classroom" },
      { region: "west", tenant: "another" },
    ]) {
      const changed = prepareTraceConnection(entry.traces, values, previous);
      expect(nextTraceConfiguration(entry.manifest.id, true, changed, previous).epoch).not.toBe(
        previous.epoch,
      );
    }
    const publicState = projectTraceSettings(
      { ...current, observability: { ...previous, values: { region: "west" } } },
      [entry],
      {},
    );
    expect(publicState.plugins[0]?.values).toStrictEqual({ region: "west" });
    expect(publicState.plugins[0]?.secrets).toStrictEqual([]);
  } finally {
    f.database.close();
  }
});
