import { expect, it } from "vitest";
import { recommendedNotes } from "./preview-recommend.js";
const inventories = (length: number) =>
  Array.from({ length }, () => ({ supportedProtocolVersions: ["0.1"] }));
const release = (version: string, body: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: true,
  body,
});
it("promotes independently and idempotently without altering existing notes", () => {
  const student = "<!-- marea-recommended:student:0.1 -->";
  const server = "<!-- marea-recommended:server:0.1 -->";
  const releases = [release("0.1.0-preview.2", `Notes\n${student}`)];
  expect(recommendedNotes([], "0.1.0-preview.1", "server", "Notes", inventories(3))).toBe(
    `Notes\n\n${server}\n`,
  );
  expect(
    recommendedNotes(releases, "0.1.0-preview.2", "student", `Notes\r\n${student}`, inventories(5)),
  ).toBe(`Notes\r\n${student}`);
  expect(
    recommendedNotes(releases, "0.1.0-preview.3", "student", `Notes ${student}`, inventories(5)),
  ).toBe(`Notes ${student}\n\n${student}\n`);
  expect(recommendedNotes(releases, "0.1.0-preview.1", "server", student, inventories(3))).toBe(
    `${student}\n\n${server}\n`,
  );
  expect(() =>
    recommendedNotes(releases, "0.1.0-preview.1", "student", "", inventories(5)),
  ).toThrow("backwards");
});
it("requires every native protocol inventory and a valid preview version", () => {
  for (const count of [0, 4, 6])
    expect(() =>
      recommendedNotes([], "0.1.0-preview.1", "student", "", inventories(count)),
    ).toThrow("Missing native");
  for (const count of [2, 4])
    expect(() => recommendedNotes([], "0.1.0-preview.1", "server", "", inventories(count))).toThrow(
      "Missing native",
    );
  expect(() => recommendedNotes([], "bad", "server", "", inventories(3))).toThrow();
  for (const value of [
    { supportedProtocolVersions: ["2.0"] },
    { supportedProtocolVersions: [] },
    { supportedProtocolVersions: ["invalid"] },
    { supportedProtocolVersions: ["0.1"], extra: true },
  ]) {
    expect(() =>
      recommendedNotes([], "0.1.0-preview.1", "server", "", [...inventories(2), value]),
    ).toThrow();
  }
});

it("accepts multiple supported protocols and recognizes LF markers without duplicating them", () => {
  const marker = "<!-- marea-recommended:student:0.1 -->";
  const body = `Notes\n${marker}\n`;
  expect(
    recommendedNotes(
      [],
      "0.1.0-preview.1",
      "student",
      body,
      Array.from({ length: 5 }, () => ({ supportedProtocolVersions: ["2.0", "0.1"] })),
    ),
  ).toBe(body);
  expect(() =>
    recommendedNotes([], "0.1.0-preview.1", "server", "", [
      ...inventories(2),
      { supportedProtocolVersions: ["2.0"] },
    ]),
  ).toThrow("Release does not support this recommendation's protocol");
});
