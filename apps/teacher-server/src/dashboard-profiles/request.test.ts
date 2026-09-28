import { expect, it } from "vitest";
import { parseDashboardProfileRequest } from "./request.boundary.js";
import { schemas, encode, write, request, selected, release } from "./profile.fixture.js";
const parse = (operation: string, bytes: Uint8Array) =>
  parseDashboardProfileRequest(schemas, operation, bytes, release);
it("distinguishes byte limits, malformed documents, route mismatch and unavailable selections", () => {
  expect(() => parse("save", new Uint8Array(65_537))).toThrow(
    expect.objectContaining({ status: 413 }),
  );
  expect(() => parse("save", encode(request("read")))).toThrow(
    expect.objectContaining({ status: 400 }),
  );
  expect(() =>
    parse("read", encode(write({ value: { ...release.defaults, themeId: "org.marea.missing" } }))),
  ).toThrow(expect.objectContaining({ status: 400 }));
  for (const value of [
    { ...release.defaults, themeId: "org.marea.missing" },
    { ...release.defaults, modules: [{ ...selected, configurationVersion: 2 }] },
    { ...release.defaults, modules: [{ ...selected, placement: { slot: "aside", size: "wide" } }] },
  ])
    expect(() => parse("save", encode(write({ value })))).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  for (const value of [
    write({ ownerId: "forged" }),
    write({ value: { ...release.defaults, modules: [selected, selected] } }),
    write({ expectedPersonalRevision: "different" }),
  ])
    expect(() => parse("save", encode(value))).toThrow(expect.objectContaining({ status: 400 }));
});
it("maps invalid settings to 400 and correlates valid write envelopes", () => {
  expect(() =>
    parse(
      "save",
      encode(
        write({
          value: { ...release.defaults, modules: [{ ...selected, settings: { limit: 0 } }] },
        }),
      ),
    ),
  ).toThrow(expect.objectContaining({ status: 400, requestId: "profile-request" }));
  expect(() =>
    parse(
      "save",
      encode(
        write({
          value: {
            ...release.defaults,
            modules: [{ ...selected, settings: { limit: 10, extra: true } }],
          },
        }),
      ),
    ),
  ).toThrow(expect.objectContaining({ status: 400 }));
  expect(() =>
    parse(
      "save",
      encode(
        write({
          value: { ...release.defaults, modules: [{ ...selected, moduleId: "org.marea.missing" }] },
        }),
      ),
    ),
  ).toThrow(expect.objectContaining({ status: 422 }));
});
it("accepts the exact UTF-8 document limit and rejects extra bytes and invalid decoding", () => {
  const value = request("read");
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text.padEnd(65_536));
  expect(parse("read", bytes)).toEqual(value);
  expect(() => parse("read", new Uint8Array([0xff]))).toThrow(
    expect.objectContaining({ status: 400 }),
  );
  expect(() => parse("read", new TextEncoder().encode(text.padEnd(65_537)))).toThrow(
    expect.objectContaining({ status: 413 }),
  );
});
it("classifies placement and settings failures against a multi-entry catalog", () => {
  const catalog = {
    ...release,
    modules: [release.modules[0], { ...release.modules[0], id: "org.marea.second-module" }],
    themes: [...release.themes, { ...release.themes[0], id: "org.marea.second-theme" }],
  };
  const classify = (value: object) =>
    parseDashboardProfileRequest(schemas, "save", encode(write(value)), catalog);
  for (const placement of [
    { slot: "main", size: "wide" },
    { slot: "aside", size: "standard" },
  ])
    expect(() =>
      classify({ value: { ...release.defaults, modules: [{ ...selected, placement }] } }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  expect(() =>
    classify({
      value: {
        ...release.defaults,
        modules: [selected, { ...selected, moduleId: "org.marea.absent" }],
      },
    }),
  ).toThrow(expect.objectContaining({ status: 422 }));
  expect(() =>
    classify({
      value: { ...release.defaults, modules: [{ ...selected, settings: { limit: 0 } }] },
    }),
  ).toThrow(expect.objectContaining({ status: 400 }));
  expect(() =>
    classify({
      scope: { kind: "class", classId: "class-1" },
      value: { modules: [{ ...selected, settings: { limit: 0 } }] },
    }),
  ).toThrow(expect.objectContaining({ status: 400 }));
  expect(() =>
    classify({
      scope: { kind: "class", classId: "class-1" },
      value: { themeId: "org.marea.second-theme" },
    }),
  ).toThrow(expect.objectContaining({ status: 400 }));
});
it("classifies supported placements by any matching pair", () => {
  const catalog = {
    ...release,
    modules: [
      {
        ...release.modules[0],
        supportedPlacements: [
          ...release.modules[0].supportedPlacements,
          { slot: "aside" as const, size: "wide" as const },
        ],
      },
    ],
  };
  expect(() =>
    parseDashboardProfileRequest(
      schemas,
      "save",
      encode(
        write({
          value: { ...release.defaults, modules: [{ ...selected, settings: { limit: 0 } }] },
        }),
      ),
      catalog,
    ),
  ).toThrow(expect.objectContaining({ status: 400 }));
});
it("rejects a malformed document exactly at the request limit as invalid, not oversized", () => {
  expect(() => parse("read", new Uint8Array(65_536).fill(0xff))).toThrow(
    expect.objectContaining({ status: 400 }),
  );
});
