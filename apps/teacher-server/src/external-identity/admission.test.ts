import { describe, expect, it } from "vitest";

import type { AdmissionRule } from "@marea/plugin-api";

import { admittedClassIds } from "./admission.js";

const rule = (value: string): AdmissionRule => ({ kind: "group", value });
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Checks that stay pending until the test answers them, with the peak overlap recorded. */
function gate() {
  const pending = new Map<string, PromiseWithResolvers<boolean>>();
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  return {
    started,
    peak: () => peak,
    admits: async (candidate: AdmissionRule) => {
      started.push(candidate.value);
      const deferred = Promise.withResolvers<boolean>();
      pending.set(candidate.value, deferred);
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await deferred.promise;
      } finally {
        active -= 1;
      }
    },
    answer: async (value: string, admitted: boolean) => {
      pending.get(value)?.resolve(admitted);
      await settle();
    },
    fail: async (value: string, error: Error) => {
      pending.get(value)?.reject(error);
      await settle();
    },
  };
}

const classes = [
  { classId: "a", rules: [rule("a1"), rule("a2")] },
  { classId: "b", rules: [rule("b1"), rule("b2")] },
  { classId: "c", rules: [rule("c1"), rule("c2")] },
];

describe("admittedClassIds", () => {
  it("returns nothing and asks nothing without classes or rules", async () => {
    const test = gate();
    await expect(admittedClassIds([], test.admits, 4)).resolves.toEqual([]);
    await expect(
      admittedClassIds([{ classId: "empty", rules: [] }], test.admits, 4),
    ).resolves.toEqual([]);
    expect(test.started).toEqual([]);
  });

  it("never runs more checks than the concurrency across classes and rules", async () => {
    const test = gate();
    const running = admittedClassIds(classes, test.admits, 4);
    await settle();
    expect(test.started).toEqual(["a1", "a2", "b1", "b2"]);
    await test.answer("a1", false);
    expect(test.started).toEqual(["a1", "a2", "b1", "b2", "c1"]);
    await test.answer("c1", false);
    expect(test.started).toEqual(["a1", "a2", "b1", "b2", "c1", "c2"]);
    for (const value of ["a2", "b1", "b2", "c2"]) await test.answer(value, value === "b2");
    await expect(running).resolves.toEqual(["b"]);
    expect(test.peak()).toBe(4);
  });

  it("uses only as many workers as there are checks", async () => {
    const test = gate();
    const running = admittedClassIds(
      [{ classId: "a", rules: [rule("a1"), rule("a2")] }],
      test.admits,
      4,
    );
    await settle();
    expect(test.started).toEqual(["a1", "a2"]);
    await test.answer("a1", true);
    await test.answer("a2", false);
    await expect(running).resolves.toEqual(["a"]);
    expect(test.peak()).toBe(2);
  });

  it("skips the remaining rules of a class once it is admitted", async () => {
    const test = gate();
    const running = admittedClassIds(classes, test.admits, 1);
    await settle();
    await test.answer("a1", true);
    await test.answer("b1", false);
    await test.answer("b2", false);
    await test.answer("c1", true);
    await expect(running).resolves.toEqual(["a", "c"]);
    expect(test.started).toEqual(["a1", "b1", "b2", "c1"]);
  });

  it("keeps the order of the classes whatever order the answers arrive in", async () => {
    const test = gate();
    const running = admittedClassIds(classes, test.admits, 4);
    await settle();
    await test.answer("b1", true);
    await test.answer("a1", true);
    await test.answer("a2", false);
    await test.answer("b2", false);
    await test.answer("c1", false);
    await test.answer("c2", false);
    await expect(running).resolves.toEqual(["a", "b"]);
  });

  it("fails with the first error and starts no further checks", async () => {
    const test = gate();
    const running = admittedClassIds(classes, test.admits, 2);
    const outcome = expect(running).rejects.toThrow("down");
    await settle();
    await test.fail("a1", new Error("down"));
    await outcome;
    await test.answer("a2", false);
    expect(test.started).toEqual(["a1", "a2"]);
  });
});
