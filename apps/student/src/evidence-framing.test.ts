import { expect, it } from "vitest";

import { withEvidence } from "./evidence-framing.js";

it("returns the message alone when there is no evidence", () => {
  expect(withEvidence("Explain", "")).toBe("Explain");
});

it("appends the evidence to a message that leaves room", () => {
  const text = withEvidence("Explain", "+student change");
  expect(text.startsWith("Explain\n\n<student-work-evidence>\n")).toBe(true);
  expect(text).toContain("+student change\n</student-work-evidence>");
});

it("cuts the evidence, never the message, so the pair fits one gateway message", () => {
  const message = "m".repeat(65_000);
  const text = withEvidence(message, "e".repeat(4_096));
  expect(text.length).toBe(65_536);
  expect(text.startsWith(message)).toBe(true);
  expect(text).toContain("e\n</student-work-evidence>");
});

it("keeps evidence that fits exactly", () => {
  const empty = withEvidence("x", "e").length - 1;
  const text = withEvidence("x", "e".repeat(65_536 - empty));
  expect(text.length).toBe(65_536);
  expect(text.match(/e+/gu)?.some((run) => run.length === 65_536 - empty)).toBe(true);
});

it("leaves the evidence out when the message exactly fills the limit", () => {
  const overhead = withEvidence("", "e").length - 1;
  const message = "m".repeat(65_536 - overhead);
  expect(withEvidence(message, "+change")).toBe(message);
});

it("leaves the evidence out when the message leaves no room for it", () => {
  const message = "m".repeat(65_500);
  expect(withEvidence(message, "+change")).toBe(message);
});
