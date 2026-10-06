import { ProtocolVersionSchema } from "@marea/protocol";
import { expect, it } from "vitest";
import { recommendPreview } from "./preview-recommend.js";
const inventories = (length: number) =>
  Array.from({ length }, () => ({ supportedProtocolVersions: ["0.1"] }));
const channel = {
  format: 1,
  available: "0.1.0-preview.9",
  recommended: { "0.1": { student: "0.1.0-preview.2" }, "2.0": { server: "0.1.0-preview.4" } },
};
it("promotes independently, idempotently and without altering other protocol generations", () => {
  const promoted = recommendPreview(channel, "0.1.0-preview.3", "server", inventories(3));
  expect(promoted).toEqual({
    ...channel,
    recommended: {
      ...channel.recommended,
      "0.1": { student: "0.1.0-preview.2", server: "0.1.0-preview.3" },
    },
  });
  expect(recommendPreview(promoted, "0.1.0-preview.3", "server", inventories(3))).toEqual(promoted);
  expect(
    recommendPreview({ ...channel, recommended: {} }, "0.1.0-preview.1", "student", inventories(5))
      .recommended,
  ).toEqual({ "0.1": { student: "0.1.0-preview.1" } });
  expect(() => recommendPreview(channel, "0.1.0-preview.1", "student", inventories(5))).toThrow(
    "backwards",
  );
  expect(() => recommendPreview(channel, "0.1.0-preview.10", "student", inventories(5))).toThrow(
    "not yet available",
  );
  expect(recommendPreview(channel, "0.1.0-preview.9", "student", inventories(5)).available).toBe(
    "0.1.0-preview.9",
  );
});
it("requires every signed native compatibility inventory and valid versions", () => {
  for (const count of [0, 4, 6])
    expect(() =>
      recommendPreview(channel, "0.1.0-preview.3", "student", inventories(count)),
    ).toThrow("Missing native");
  for (const count of [2, 4])
    expect(() =>
      recommendPreview(channel, "0.1.0-preview.3", "server", inventories(count)),
    ).toThrow("Missing native");
  expect(() => recommendPreview(channel, "bad", "server", inventories(3))).toThrow();
  expect(() =>
    recommendPreview(channel, "0.1.0-preview.3", "server", [
      ...inventories(2),
      { supportedProtocolVersions: ["2.0"] },
    ]),
  ).toThrow("Release does not support this recommendation's protocol");
  for (const value of [
    { supportedProtocolVersions: [] },
    { supportedProtocolVersions: ["invalid"] },
    { supportedProtocolVersions: ["0.1"], extra: true },
  ])
    expect(() =>
      recommendPreview(channel, "0.1.0-preview.3", "server", [...inventories(2), value]),
    ).toThrow();
  expect(
    recommendPreview(
      channel,
      "0.1.0-preview.3",
      "student",
      Array.from({ length: 5 }, () => ({ supportedProtocolVersions: ["2.0", "0.1"] })),
    ).recommended[ProtocolVersionSchema.parse("0.1")]?.student,
  ).toBe("0.1.0-preview.3");
});
