import { expect, it } from "vitest";
import {
  comparePreview,
  manifestAsset,
  channelVersion,
  availablePreview,
  previewChannelSchema,
  previewSettingsSchema,
  previewVersion,
  releaseUrl,
  repositoryName,
  serverOrigin,
} from "./preview-channel.js";

it("orders the explicit preview channel numerically without mixing stable or arbitrary tags", () => {
  const values = [
    "0.1.0-preview.9",
    "0.1.0-preview.10",
    "0.1.1-preview.0",
    "0.2.0-preview.0",
    "1.0.0-preview.0",
  ];
  for (const [index, value] of values.entries()) {
    expect(comparePreview(value, value)).toBe(0);
    for (const next of values.slice(index + 1)) {
      expect(comparePreview(value, next)).toBe(-1);
      expect(comparePreview(next, value)).toBe(1);
    }
  }
  expect(comparePreview("1.0.0-preview.9007199254740993", "1.0.0-preview.9007199254740992")).toBe(
    1,
  );
  for (const value of [
    "1.0.0",
    "1.0.0-rc.1",
    "01.0.0-preview.1",
    "1.0.0-preview.01",
    "v1.0.0-preview.1",
    "../evil",
  ])
    expect(previewVersion.safeParse(value).success).toBe(false);
});

it("constructs fixed GitHub assets and accepts explicit HTTP origins but refuses embedded credentials", () => {
  expect(releaseUrl("school/marea", "1.0.0-preview.1", "student-linux-x64.manifest.json")).toBe(
    "https://github.com/school/marea/releases/download/v1.0.0-preview.1/student-linux-x64.manifest.json",
  );
  expect(manifestAsset("student", "win32-arm64")).toBe("student-win32-arm64.manifest.json");
  for (const asset of ["../a", "a/b", "a?b", "a#b", ""])
    expect(() => releaseUrl("a/b", "1.0.0-preview.1", asset)).toThrow();
  expect(() => releaseUrl("a/b/c", "1.0.0-preview.1", "asset")).toThrow();
  for (const origin of [
    "https://school.test",
    "http://school.test",
    "http://192.168.1.20:18787",
    "http://localhost:18787",
    "http://127.0.0.1:18787",
    "http://[::1]:18787",
  ])
    expect(serverOrigin(`${origin}/`)).toBe(origin);
  for (const origin of [
    "https://user:secret@school.test",
    "https://school.test/a",
    "https://school.test/?a",
    "https://school.test/#a",
    "ftp://localhost",
    "invalid",
  ])
    expect(() => serverOrigin(origin)).toThrow();
  expect(
    previewSettingsSchema.parse({
      format: 1,
      repository: "a/b",
      component: "server",
      channel: "preview",
      installation: "/private",
    }).installation,
  ).toBe("/private");
  expect(() =>
    previewSettingsSchema.parse({
      format: 1,
      repository: "a/b",
      component: "student",
      channel: "stable",
    }),
  ).toThrow();
});

it("bounds untrusted versions and repositories and validates saved settings", () => {
  for (const value of ["1.2.3-preview.4", "11.22.33-preview.44", "0.0.0-preview.0"])
    expect(previewVersion.parse(value)).toBe(value);
  for (const value of [
    "!1.2.3-preview.4",
    "1.2.3-preview.4!",
    "1.02.3-preview.4",
    "1.2.03-preview.4",
    "1x.2.3-preview.4",
    "1.2x.3-preview.4",
    "1.2.3x-preview.4",
    "1.2.3-preview.4x",
    "1".repeat(65) + ".0.0-preview.1",
  ])
    expect(previewVersion.safeParse(value).success).toBe(false);
  expect(repositoryName.parse("School-name/repo_name.2")).toBe("School-name/repo_name.2");
  for (const value of ["!a/b", "a/b!", "a/b/c"])
    expect(repositoryName.safeParse(value).success).toBe(false);
  expect(() => releaseUrl("a/b", "invalid", "asset")).toThrow();
  expect(() => releaseUrl("a/b", "1.0.0-preview.1", "!")).toThrow("Invalid release asset");
  expect(() => serverOrigin("https://user@school.test")).toThrow("HTTPS server origin");
  const settings = {
    format: 1,
    repository: "a/b",
    component: "student",
    channel: "preview",
    serverUrl: "https://school.test",
  };
  expect(previewSettingsSchema.parse(settings)).toEqual(settings);
  expect(() => previewSettingsSchema.parse({ ...settings, format: 2 })).toThrow();
  expect(() => previewSettingsSchema.parse({ ...settings, unknown: true })).toThrow();
});

it("keeps available versions independent from component and protocol recommendations", () => {
  const channel = {
    format: 1,
    available: "0.1.0-preview.9",
    recommended: {
      "0.1": { student: "0.1.0-preview.6", server: "0.1.0-preview.5" },
      "2.0": { student: "0.1.0-preview.8" },
    },
  };
  expect(channelVersion(channel, "student", "available")).toBe("0.1.0-preview.9");
  expect(channelVersion(channel, "server", "available")).toBe("0.1.0-preview.9");
  expect(channelVersion(channel, "student", "recommended")).toBe("0.1.0-preview.6");
  expect(channelVersion(channel, "server", "recommended")).toBe("0.1.0-preview.5");
  expect(channelVersion({ ...channel, recommended: {} }, "student", "recommended")).toBeUndefined();
  expect(
    channelVersion({ ...channel, recommended: { "0.1": {} } }, "server", "recommended"),
  ).toBeUndefined();
  expect(availablePreview(undefined, "0.1.0-preview.1")).toEqual({
    format: 1,
    available: "0.1.0-preview.1",
    recommended: {},
  });
  expect(availablePreview(channel, "0.1.0-preview.10")).toEqual({
    ...channel,
    available: "0.1.0-preview.10",
  });
  expect(availablePreview(channel, "0.1.0-preview.9")).toEqual(channel);
  expect(availablePreview(channel, "0.1.0-preview.8")).toEqual(channel);
  for (const value of [
    { ...channel, format: 2 },
    { ...channel, available: "1.0.0" },
    { ...channel, extra: true },
    { ...channel, recommended: { bad: {} } },
    { ...channel, recommended: { "0.1": { extra: true } } },
  ])
    expect(previewChannelSchema.safeParse(value).success).toBe(false);
  expect(() => availablePreview(undefined, "invalid")).toThrow();
});
