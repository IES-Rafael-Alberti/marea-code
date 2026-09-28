import { describe, expect, it } from "vitest";
import { parseAdoptionMap } from "./adoption-validation.boundary.js";
import { GovernanceResourceError } from "./errors.js";

const empty = { classes: [], accounts: [], administrators: [] };
describe("bounded explicit adoption maps", () => {
  it("snapshots and canonicalizes each independent mapping and explicit grant", () => {
    const unordered = {
      classes: [
        { classId: "class:z", centerId: "center:a" },
        { classId: "class:a", centerId: "center:a" },
      ],
      accounts: [
        { userId: "user:z", ownerCenterId: "center:a" },
        { userId: "user:a", ownerCenterId: "center:a" },
      ],
      administrators: [
        { userId: "user:z", centerId: "center:a" },
        { userId: "user:a", centerId: "center:a" },
      ],
    };
    const parsed = parseAdoptionMap(unordered);
    expect(parsed.classes.map((entry) => entry.classId)).toEqual(["class:a", "class:z"]);
    expect(parsed.accounts.map((entry) => entry.userId)).toEqual(["user:a", "user:z"]);
    expect(parsed.administrators.map((entry) => entry.userId)).toEqual(["user:a", "user:z"]);
    expect(parseAdoptionMap(parsed)).toEqual(parsed);
    unordered.classes.reverse();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.accounts)).toBe(true);
    expect(Object.isFrozen(parsed.accounts[0])).toBe(true);
  });

  it.each([
    null,
    {},
    { ...empty, unknown: true },
    { ...empty, classes: [{ classId: "bad/id", centerId: "center:a" }] },
    { ...empty, classes: [{ classId: "class:a", centerId: "center:a", extra: true }] },
    {
      ...empty,
      classes: [
        { classId: "class:a", centerId: "center:a" },
        { classId: "class:a", centerId: "center:b" },
      ],
    },
    {
      ...empty,
      accounts: [
        { userId: "user:a", ownerCenterId: "center:a" },
        { userId: "user:a", ownerCenterId: "center:b" },
      ],
    },
    {
      ...empty,
      administrators: [
        { userId: "user:a", centerId: "center:a" },
        { userId: "user:a", centerId: "center:a" },
      ],
    },
  ])("rejects invalid or duplicate mappings without inferred repair", (value) => {
    expect(() => parseAdoptionMap(value)).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
  });

  it("enforces both aggregate identity count and UTF-8 bytes before inventory work", () => {
    const accounts = Array.from({ length: 10000 }, (_, index) => ({
      userId: `user:${String(index)}`,
      ownerCenterId: "center:a",
    }));
    expect(parseAdoptionMap({ ...empty, accounts }).accounts).toHaveLength(10000);
    expect(() =>
      parseAdoptionMap({
        ...empty,
        accounts,
        classes: [{ classId: "class:a", centerId: "center:a" }],
      }),
    ).toThrow(GovernanceResourceError);
    expect(() =>
      parseAdoptionMap({
        ...empty,
        accounts: [...accounts, { userId: "user:extra", ownerCenterId: "center:a" }],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-request" }));
    const long = "x".repeat(128);
    const largeAccounts = accounts.map((entry) => ({
      userId: entry.userId.padEnd(128, "x"),
      ownerCenterId: long,
    }));
    const administrators = largeAccounts.map((entry) => ({ userId: entry.userId, centerId: long }));
    expect(() => parseAdoptionMap({ ...empty, accounts: largeAccounts, administrators })).toThrow(
      GovernanceResourceError,
    );
    expect(new GovernanceResourceError()).toMatchObject({
      name: "GovernanceResourceError",
      message: "Governance resource limit exceeded.",
    });
  });

  it("accepts exactly four MiB and rejects the next valid byte", () => {
    const accounts = Array.from({ length: 10000 }, (_, index) => ({
      userId: `user:${String(index)}`.padEnd(128, "x"),
      ownerCenterId: "c",
    }));
    const administrators = accounts.map(({ userId }) => ({ userId, centerId: "c" }));
    const map = { ...empty, accounts, administrators };
    let remaining = 4194304 - Buffer.byteLength(JSON.stringify(map));
    for (const entry of accounts) {
      const padding = Math.min(127, remaining);
      entry.ownerCenterId += "x".repeat(padding);
      remaining -= padding;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(map))).toBe(4194304);
    expect(parseAdoptionMap(map).accounts).toHaveLength(10000);
    const first = administrators[0];
    if (first === undefined) throw new Error("Missing administrator fixture");
    first.centerId += "x";
    expect(() => parseAdoptionMap(map)).toThrow(GovernanceResourceError);
  });
});
