import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sha256DigestSchema } from "@marea/protocol";
import { afterEach, expect, it } from "vitest";

import { createFileEffectLedger, type EffectLedgerRecord } from "./effect-ledger.boundary.js";

const digest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function record(index: number, phase: EffectLedgerRecord["phase"]): EffectLedgerRecord {
  return {
    beforeDigest: null,
    contentDigest: digest,
    effectId: `effect:${String(index)}`,
    operation: "created",
    path: `file-${String(index)}.txt`,
    phase,
  };
}

async function newLedger(retained?: number) {
  const root = await mkdtemp(join(tmpdir(), "marea-ledger-"));
  roots.push(root);
  return { ledger: createFileEffectLedger(root, retained), root };
}

it("drops the oldest completed records once the ledger exceeds its retention", async () => {
  const { ledger, root } = await newLedger(3);
  for (let index = 1; index <= 6; index += 1) await ledger.put(record(index, "completed"));

  const file = JSON.parse(await readFile(join(root, "workspace-effects.json"), "utf8")) as {
    effects: { effectId: string }[];
  };
  expect(file.effects.map((effect) => effect.effectId)).toEqual([
    "effect:4",
    "effect:5",
    "effect:6",
  ]);
  expect(await ledger.find("effect:1")).toBeNull();
  expect(await ledger.find("effect:6")).toEqual(record(6, "completed"));
});

it("never drops a prepared record, which is unfinished work", async () => {
  const { ledger } = await newLedger(2);
  await ledger.put(record(1, "prepared"));
  for (let index = 2; index <= 5; index += 1) await ledger.put(record(index, "completed"));

  expect(await ledger.find("effect:1")).toEqual(record(1, "prepared"));
  expect(await ledger.find("effect:2")).toBeNull();
  expect(await ledger.find("effect:3")).toBeNull();
  expect(await ledger.find("effect:4")).toBeNull();
  expect(await ledger.find("effect:5")).toEqual(record(5, "completed"));
});

it("retains every record while the ledger stays within its default retention", async () => {
  const { ledger } = await newLedger();
  for (let index = 1; index <= 20; index += 1) await ledger.put(record(index, "completed"));

  expect(await ledger.find("effect:1")).toEqual(record(1, "completed"));
});
