import { expect, it } from "vitest";
import {
  comparePreview,
  manifestAsset,
  newestPreview,
  previewSettingsSchema,
  previewVersion,
  releaseUrl,
  repositoryName,
  recommendationMarker,
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
  const entry = (tag_name: string, draft = false, prerelease = true) => ({
    tag_name,
    draft,
    prerelease,
  });
  expect(
    newestPreview([
      entry("v0.1.0-preview.9"),
      entry("v0.1.0-preview.10"),
      entry("v9.0.0-preview.0", true),
      entry("v8.0.0-preview.0", false, false),
      entry("v9.0.0"),
      entry("0.1.0-preview.20"),
    ]),
  ).toBe("0.1.0-preview.10");
  expect(newestPreview([])).toBeUndefined();
  expect(() => newestPreview([{}])).toThrow();
});

it("constructs fixed GitHub assets and refuses insecure school origins or embedded credentials", () => {
  expect(releaseUrl("school/marea", "1.0.0-preview.1", "student-linux-x64.manifest.json")).toBe(
    "https://github.com/school/marea/releases/download/v1.0.0-preview.1/student-linux-x64.manifest.json",
  );
  expect(manifestAsset("student", "win32-arm64")).toBe("student-win32-arm64.manifest.json");
  for (const asset of ["../a", "a/b", "a?b", "a#b", ""])
    expect(() => releaseUrl("a/b", "1.0.0-preview.1", asset)).toThrow();
  expect(() => releaseUrl("a/b/c", "1.0.0-preview.1", "asset")).toThrow();
  for (const origin of [
    "https://school.test",
    "http://localhost:18787",
    "http://127.0.0.1:18787",
    "http://[::1]:18787",
  ])
    expect(serverOrigin(`${origin}/`)).toBe(origin);
  for (const origin of [
    "http://school.test",
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
  const entry = (tag_name: string) => ({ tag_name, draft: false, prerelease: true });
  expect(newestPreview([entry("v0.2.0-preview.2"), entry("v0.1.0-preview.1")])).toBe(
    "0.2.0-preview.2",
  );
  expect(newestPreview([entry("untagged")])).toBeUndefined();
  expect(newestPreview([entry("x9.0.0-preview.1")])).toBeUndefined();
  expect(() =>
    newestPreview(Array.from({ length: 101 }, () => entry("v0.1.0-preview.1"))),
  ).toThrow();
});

it("recommends components separately and never treats an ordinary publication as recommended", () => {
  const entry = (version: number, body?: string | null) => ({
    tag_name: `v0.1.0-preview.${String(version)}`,
    draft: false,
    prerelease: true,
    body,
  });
  const releases = [
    entry(9),
    entry(8, null),
    entry(7, "not a recommendation"),
    entry(6, "prefix <!-- marea-recommended:student:0.1 --> suffix"),
    entry(5, recommendationMarker("student") + "\r\nnotes"),
    entry(4, "notes\n" + recommendationMarker("server")),
    entry(3, recommendationMarker("student")),
  ];
  expect(newestPreview(releases)).toBe("0.1.0-preview.9");
  expect(newestPreview(releases, "student")).toBe("0.1.0-preview.5");
  expect(newestPreview(releases, "server")).toBe("0.1.0-preview.4");
  expect(newestPreview([entry(1)], "student")).toBeUndefined();
  expect(recommendationMarker("student")).toBe("<!-- marea-recommended:student:0.1 -->");
  expect(recommendationMarker("server")).toBe("<!-- marea-recommended:server:0.1 -->");
});

it("keeps recommendations for different wire protocol generations separate", () => {
  expect(
    newestPreview(
      [
        {
          tag_name: "v0.1.0-preview.9",
          draft: false,
          prerelease: true,
          body: "<!-- marea-recommended:student:2.0 -->",
        },
      ],
      "student",
    ),
  ).toBeUndefined();
});
