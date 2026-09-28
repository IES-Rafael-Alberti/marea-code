import { describe, expect, it } from "vitest";

import { readGovernancePages } from "./governance-controller-pagination.js";
import {
  isCenterScoped,
  isClassScoped,
  hasClassIdentity,
} from "./governance-controller-validation.js";
import { CLASS_A, CENTER_A, CENTER_B } from "./governance-controller.fixture.js";

function row(centerId: string, classId = CLASS_A) {
  return { centerId, classId, id: `${centerId}:${classId}` };
}

describe("governance pagination and scope predicates", () => {
  const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
  const pages = (
    responses: Record<string, { items: { id: string }[]; nextAfterId: string | null }>,
  ) => {
    const requested: (string | null)[] = [];
    const read = (afterId: string | null) => {
      if (requested.includes(afterId)) throw new Error(`repeated cursor ${String(afterId)}`);
      requested.push(afterId);
      const response = responses[afterId ?? "first"];
      if (response === undefined) throw new Error(`unexpected cursor ${String(afterId)}`);
      return Promise.resolve(response);
    };
    return { read, requested };
  };

  it("follows server continuation cursors that name the last item of each page", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: `item:${String(index).padStart(3, "0")}`,
    }));
    const { read, requested } = pages({
      first: { items: first, nextAfterId: "item:099" },
      "item:099": { items: [{ id: "item:100" }], nextAfterId: null },
    });
    const result = await readGovernancePages(
      read,
      (item) => item.id,
      () => true,
    );
    expect(result).toHaveLength(101);
    expect(requested).toEqual([null, "item:099"]);
  });

  it("rejects oversized pages, unordered items and inconsistent cursors", async () => {
    const oversized = Array.from({ length: 101 }, (_, index) => ({ id: `id:${String(index)}` }));
    const invalid: [string, { items: { id: string }[]; nextAfterId: string | null }][] = [
      ["bound", { items: oversized, nextAfterId: null }],
      ["not ascending", { items: [{ id: "id:a" }, { id: "id:a" }], nextAfterId: null }],
      ["not ascending", { items: [{ id: "id:b" }, { id: "id:a" }], nextAfterId: null }],
      ["not ascending", { items: [{ id: "id:aa" }, { id: "id:a" }], nextAfterId: null }],
      ["did not advance", { items: [{ id: "id:a" }, { id: "id:b" }], nextAfterId: "id:a" }],
      ["did not advance", { items: [], nextAfterId: "id:a" }],
    ];
    for (const [message, response] of invalid) {
      await expect(
        readGovernancePages(
          () => Promise.resolve(response),
          (item) => item.id,
          () => true,
        ),
      ).rejects.toThrow(message);
    }
    const repeated = pages({
      first: { items: [{ id: "id:a" }], nextAfterId: "id:a" },
      "id:a": { items: [], nextAfterId: "id:a" },
    });
    await expect(
      readGovernancePages(
        repeated.read,
        (item) => item.id,
        () => true,
      ),
    ).rejects.toThrow("did not advance");
    const backwards = pages({
      first: { items: [{ id: "id:b" }], nextAfterId: "id:b" },
      "id:b": { items: [{ id: "id:a" }], nextAfterId: null },
    });
    await expect(
      readGovernancePages(
        backwards.read,
        (item) => item.id,
        () => true,
      ),
    ).rejects.toThrow("not ascending");
    const prefix = pages({
      first: {
        items: [{ id: "A:1" }, { id: "id:a" }, { id: "id:aa" }, { id: "id:b" }],
        nextAfterId: null,
      },
    });
    expect(
      ids(
        await readGovernancePages(
          prefix.read,
          (item) => item.id,
          () => true,
        ),
      ),
    ).toEqual(["A:1", "id:a", "id:aa", "id:b"]);
  });

  it("stops before and after a read that becomes stale", async () => {
    const neverStarted = pages({ first: { items: [], nextAfterId: null } });
    await expect(
      readGovernancePages(
        neverStarted.read,
        (item) => item.id,
        () => false,
      ),
    ).resolves.toBeNull();
    expect(neverStarted.requested).toEqual([]);
    let current = true;
    const pending = readGovernancePages(
      () => {
        current = false;
        return Promise.resolve({ items: [{ id: "item:a" }], nextAfterId: null });
      },
      (item) => item.id,
      () => current,
    );
    await expect(pending).resolves.toBeNull();
  });

  it("requires every row to match its center/class scope", () => {
    const valid = [row(CENTER_A), row(CENTER_A, "class:b")];
    expect(isCenterScoped(valid, CENTER_A)).toBe(true);
    expect(isClassScoped([row(CENTER_A)], CENTER_A, CLASS_A)).toBe(true);
    expect(isCenterScoped([...valid, row(CENTER_B)], CENTER_A)).toBe(false);
    expect(isClassScoped([...valid, row(CENTER_A, "class:b")], CENTER_A, CLASS_A)).toBe(false);
    expect(hasClassIdentity(row(CENTER_A), CENTER_A, CLASS_A)).toBe(true);
    expect(hasClassIdentity(row(CENTER_B), CENTER_A, CLASS_A)).toBe(false);
    expect(hasClassIdentity(row(CENTER_A, "class:b"), CENTER_A, CLASS_A)).toBe(false);
  });
});
