import { describe, it, expect, vi } from "vitest";
import { fixture } from "./insights.fixture.js";
import { teacher, NOW } from "../../test-support/evaluation-fixture.js";
function active(f: ReturnType<typeof fixture>) {
  f.database.execute(
    "INSERT INTO marea_active_runs VALUES ('run:a','s1','class:one','Project',?1,?1,2,0)",
    [NOW],
  );
  f.progress.configure("class:one", { map: true, adaptive: false }, "initial");
  f.service.map.heartbeat("run:a");
}
describe("ephemeral attention map", () => {
  it("calls no model without viewers, shares analysis across viewers and expires presence", async () => {
    const f = fixture();
    active(f);
    const generate = vi
      .spyOn(f.service.inference, "generate")
      .mockImplementation((_r, _a, _s, _m, schema) =>
        Promise.resolve(
          schema.parse({
            state: "yellow",
            reason: "Needs a concrete example",
            confidence: "medium",
          }),
        ),
      );
    await f.service.map.tick();
    expect(generate).not.toHaveBeenCalled();
    f.service.map.read(teacher, "class:one", "viewer:one", true);
    f.service.map.read(teacher, "class:one", "viewer:two", true);
    await f.service.map.tick();
    await f.service.map.tick();
    expect(generate).toHaveBeenCalledOnce();
    expect(f.service.map.read(teacher, "class:one", "viewer:one", true).entries[0]).toMatchObject({
      state: "yellow",
      confidence: "medium",
    });
    f.now("2026-09-07T12:06:00.000Z");
    await f.service.map.tick();
    expect(generate).toHaveBeenCalledOnce();
    expect(f.service.map.read(teacher, "class:one", "viewer:one", true).entries[0]?.state).toBe(
      "disconnected",
    );
    expect(f.service.map.diagnoses.size).toBe(0);
  });
  it("aborts analysis after its last viewer leaves and never publishes its late result", async () => {
    const f = fixture();
    active(f);
    const pending = Promise.withResolvers<{ state: "green"; reason: string; confidence: "high" }>();
    let signal: AbortSignal | undefined;
    vi.spyOn(f.service.inference, "generate").mockImplementation(
      (_r, _a, _s, _m, schema, abort) => {
        signal = abort;
        return pending.promise.then((value) => schema.parse(value));
      },
    );
    f.service.map.read(teacher, "class:one", "viewer:one", true);
    const tick = f.service.map.tick();
    f.service.map.read(teacher, "class:one", "viewer:one", false);
    expect(signal?.aborted).toBe(true);
    pending.resolve({ state: "green", reason: "Late", confidence: "high" });
    await tick;
    expect(f.service.map.diagnoses.size).toBe(0);
  });
  it("ignores free sessions and removes revoked viewers", async () => {
    const f = fixture();
    active(f);
    f.database.execute(
      "UPDATE marea_run_snapshots SET public_snapshot_json = json_set(public_snapshot_json,'$.agentMode','free')",
    );
    const generate = vi.spyOn(f.service.inference, "generate");
    expect(f.service.map.read(teacher, "class:one", "viewer:one", true).entries).toEqual([]);
    await f.service.map.tick();
    expect(generate).not.toHaveBeenCalled();
    f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
    await f.service.map.tick();
    expect(f.service.map.viewers.size).toBe(0);
  });
});
