import { describe, expect, it } from "vitest";
import * as z from "zod";
import { MAX_MATERIAL_BYTES, materialLimit, materialOf } from "./report-sources.js";
import { PROMPT_RESERVE_BYTES } from "./reports-model.js";
import type { EducationalRoute } from "./configuration.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";

const event = (size: number) => JSON.stringify({ c: "x".repeat(size - 8) });
const bytes = (value: string) => Buffer.byteLength(value);
const omitted = (material: string) =>
  z.object({ omittedEarlierEvents: z.number() }).loose().parse(JSON.parse(material))
    .omittedEarlierEvents;

describe("materialOf", () => {
  it("keeps every event and states that nothing was omitted", () => {
    const events = [event(20), event(30)];
    expect(materialOf(events, 0)).toEqual({
      material: `{"events":[${events.join(",")}],"omittedEarlierEvents":0}`,
      skip: undefined,
    });
  });
  it("reports events cut by the event limit", () => {
    expect(materialOf([event(20)], 500).material).toBe(
      `{"events":[${event(20)}],"omittedEarlierEvents":500}`,
    );
  });
  it("returns nothing for a session without events", () => {
    expect(materialOf([], 0)).toEqual({ material: "", skip: undefined });
  });
  it("accepts exactly the byte limit", () => {
    const wrapper = bytes('{"events":[],"omittedEarlierEvents":0}');
    const exact = materialOf([event(MAX_MATERIAL_BYTES - wrapper)], 0);
    expect(bytes(exact.material)).toBe(MAX_MATERIAL_BYTES);
    expect(exact.skip).toBeUndefined();
  });
  it("drops the oldest events first, one at a time, until the rest fits", () => {
    const wrapper = bytes('{"events":[],"omittedEarlierEvents":1}');
    const size = 1000;
    const count = Math.floor((MAX_MATERIAL_BYTES - wrapper + 1) / (size + 1));
    const events = Array.from({ length: count + 1 }, (_v, i) =>
      JSON.stringify({ n: String(i).padStart(4, "0"), c: "x".repeat(size - 19) }),
    );
    expect(events.every((e) => bytes(e) === size)).toBe(true);
    const parsed = JSON.parse(materialOf(events, 0).material) as {
      events: { n: string }[];
      omittedEarlierEvents: number;
    };
    expect(parsed.omittedEarlierEvents).toBe(1);
    expect(parsed.events).toHaveLength(count);
    expect(parsed.events[0]?.n).toBe("0001");
    expect(parsed.events.at(-1)?.n).toBe(String(count).padStart(4, "0"));
    const all = materialOf(events.slice(1), 0);
    expect(omitted(all.material)).toBe(0);
    expect(bytes(all.material)).toBeLessThanOrEqual(MAX_MATERIAL_BYTES);
  });
  it("counts the digits of the omitted total when measuring", () => {
    const wrapper = bytes('{"events":[],"omittedEarlierEvents":0}');
    const fits = event(MAX_MATERIAL_BYTES - wrapper);
    expect(materialOf([fits], 0).skip).toBeUndefined();
    expect(materialOf([fits], 9).skip).toBeUndefined();
    expect(materialOf([fits], 10)).toEqual({ material: "", skip: "material-too-large" });
  });
  it("drops the oldest of two events when separators make them too large", () => {
    const wrapper = bytes('{"events":[],"omittedEarlierEvents":0}');
    const half = (MAX_MATERIAL_BYTES - wrapper - 1) / 2;
    const first = event(Math.floor(half));
    const second = event(Math.ceil(half) + 1);
    const result = materialOf([first, second], 0);
    expect(result.material).toBe(`{"events":[${second}],"omittedEarlierEvents":1}`);
    const fitting = materialOf([event(Math.floor(half)), event(Math.ceil(half))], 0);
    expect(omitted(fitting.material)).toBe(0);
  });
  it("marks the session too large when no single event fits", () => {
    expect(materialOf([event(MAX_MATERIAL_BYTES)], 0)).toEqual({
      material: "",
      skip: "material-too-large",
    });
  });
});

describe("materialLimit", () => {
  const limited = SYNTHETIC_ROUTE_BUDGET.evaluation;
  const route = (ceiling: number, unlimited = false): EducationalRoute => ({
    providerId: "p",
    model: "m",
    budget: unlimited
      ? { ...limited, unlimited: true, maxRequests: 0, maxTokens: 0, maxCostUnits: 0 }
      : limited,
    inputTokenCeiling: ceiling,
  });
  const teaching = { text: "t".repeat(100) };
  const size = Buffer.byteLength(JSON.stringify(teaching));
  it("never exceeds the per-run cap", () => {
    expect(materialLimit(route(10_000_000), teaching)).toBe(MAX_MATERIAL_BYTES);
    expect(materialLimit(route(1, true), teaching)).toBe(MAX_MATERIAL_BYTES);
  });
  it("leaves room for the prompt and the teaching snapshot within the ceiling", () => {
    expect(materialLimit(route(65536), teaching)).toBe(65536 - PROMPT_RESERVE_BYTES - size);
    expect(materialLimit(route(MAX_MATERIAL_BYTES + PROMPT_RESERVE_BYTES + size), teaching)).toBe(
      MAX_MATERIAL_BYTES,
    );
    expect(
      materialLimit(route(MAX_MATERIAL_BYTES + PROMPT_RESERVE_BYTES + size - 1), teaching),
    ).toBe(MAX_MATERIAL_BYTES - 1);
  });
  it("is not positive when the teaching alone fills the ceiling", () => {
    expect(materialLimit(route(PROMPT_RESERVE_BYTES), teaching)).toBe(-size);
    expect(materialOf([event(20)], 0, -size)).toEqual({ material: "", skip: "material-too-large" });
  });
});
