import { expect, it } from "vitest";
import { hasVerifiedPublication } from "./preview-publication-evidence.js";

const commit = "a".repeat(40);
const publish = { name: "publish", conclusion: "success" };
const tested = {
  name: "Verify public student and server installs, retained data and clean reinstall",
  conclusion: "success",
};
const advertised = {
  name: "Make the tested publication available without recommending it",
  conclusion: "failure",
};
const channel = { name: "available-channel", conclusion: "failure", steps: [tested, advertised] };

it("requires a successful publisher for the exact signed source", () => {
  const run = { head_sha: commit, conclusion: "success" };
  expect(hasVerifiedPublication(run, commit, [publish])).toBe(true);
  expect(hasVerifiedPublication(run, "b".repeat(40), [publish])).toBe(false);
  expect(hasVerifiedPublication(run, commit, [])).toBe(false);
  expect(hasVerifiedPublication(run, commit, [{ ...publish, name: "unrelated" }])).toBe(false);
  expect(hasVerifiedPublication(run, commit, [{ ...publish, conclusion: "failure" }])).toBe(false);
});

it("allows only a completed metadata advertisement failure after successful public installation tests", () => {
  const run = { head_sha: commit, conclusion: "failure" };
  expect(hasVerifiedPublication(run, commit, [publish, channel])).toBe(true);
  for (const conclusion of [null, "cancelled", "timed_out"])
    expect(hasVerifiedPublication({ ...run, conclusion }, commit, [publish, channel])).toBe(false);
  for (const invalid of [
    undefined,
    { ...channel, name: "unrelated" },
    { ...channel, conclusion: "success" },
    { ...channel, steps: undefined },
    { ...channel, steps: [] },
    { ...channel, steps: [advertised] },
    { ...channel, steps: [tested] },
    { ...channel, steps: [tested, { ...advertised, name: "unknown failure" }] },
    { ...channel, steps: [tested, advertised, { name: "cleanup", conclusion: "failure" }] },
    { ...channel, steps: [{ ...tested, conclusion: "failure" }, advertised] },
    { ...channel, steps: [{ ...tested, conclusion: "skipped" }, advertised] },
    { ...channel, steps: [{ ...tested, name: "unrelated" }, advertised] },
  ])
    expect(hasVerifiedPublication(run, commit, invalid ? [publish, invalid] : [publish])).toBe(
      false,
    );
});
