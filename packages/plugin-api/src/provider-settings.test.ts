import { expect, it } from "vitest";
import { ProviderSettingsDescriptorSchema } from "./provider-settings.js";

const label = { es: "Campo", en: "Field", eu: "Eremua" };
const descriptor = (fields: object[]) => ({ version: 1, name: label, fields });
const parse = (fields: object[]) => ProviderSettingsDescriptorSchema.safeParse(descriptor(fields));
const key = { key: "apiKey", label, kind: "secret", required: true };
const endpoint = { key: "endpoint", label, kind: "url", required: false, defaultValue: "x" };
const region = { key: "region_2", label, kind: "text", required: false };

it("accepts localized text, secret and URL fields", () => {
  expect(parse([key, endpoint, region]).success).toBe(true);
});

it("anchors field keys to identifier syntax", () => {
  for (const name of ["9key", "key-name", "_key", "k".repeat(65)])
    expect(parse([{ ...region, key: name }]).success).toBe(false);
  expect(parse([{ ...region, key: "k".repeat(64) }]).success).toBe(true);
});

it("rejects duplicate keys and any secret with a default, with one explanation", () => {
  for (const fields of [
    [key, { ...key }],
    [{ ...key, defaultValue: "synthetic-default-secret" }, region],
  ])
    expect(parse(fields).error?.issues).toEqual([
      expect.objectContaining({
        code: "custom",
        message: "Duplicate fields or secret defaults are not permitted",
      }),
    ]);
});

it("validates plugin guides, HTTPS help links and optional field groups", () => {
  const base = {
    ...descriptor([key, endpoint, region]),
    guides: [
      {
        id: "connection",
        title: label,
        steps: [{ text: label }, { text: label, href: "https://example.test/help" }],
        fields: ["endpoint"],
      },
    ],
  };
  expect(ProviderSettingsDescriptorSchema.parse(base)).toEqual(base);
  expect(
    ProviderSettingsDescriptorSchema.safeParse({
      ...base,
      guides: [{ ...base.guides[0], fields: undefined }],
    }).success,
  ).toBe(true);
  for (const fields of [["apiKey"], ["unknown"], ["endpoint", "endpoint"]])
    expect(
      ProviderSettingsDescriptorSchema.safeParse({
        ...base,
        guides: [{ ...base.guides[0], fields }],
      }).success,
    ).toBe(false);
  expect(
    ProviderSettingsDescriptorSchema.safeParse({
      ...base,
      guides: [base.guides[0], base.guides[0]],
    }).success,
  ).toBe(false);
  for (const href of ["javascript:alert(1)", "http://example.test", "invalid"])
    expect(
      ProviderSettingsDescriptorSchema.safeParse({
        ...base,
        guides: [{ ...base.guides[0], steps: [{ text: label, href }] }],
      }).success,
    ).toBe(false);
});

it("keeps guide IDs unique independently of field groups and anchors help metadata", () => {
  const guide = { id: "connection", title: label, steps: [{ text: label }] };
  const read = (guides: object[]) =>
    ProviderSettingsDescriptorSchema.safeParse({ ...descriptor([key, endpoint, region]), guides });
  expect(read([guide, guide]).error?.issues).toEqual([
    {
      path: [],
      code: "custom",
      message: "Guide fields must name distinct optional settings and guide IDs must be unique.",
    },
  ]);
  for (const id of ["!connection", "connection!"])
    expect(read([{ ...guide, id }]).success).toBe(false);
  for (const href of ["xhttps://example.test", "httpsx://example.test"])
    expect(read([{ ...guide, steps: [{ text: label, href }] }]).success).toBe(false);
  expect(read([{ ...guide, fields: [] }]).success).toBe(false);
  expect(read([{ ...guide, fields: ["endpoint", "region_2"] }]).success).toBe(true);
  expect(read([]).success).toBe(true);
  expect(read([guide, { ...guide, id: "groups" }]).success).toBe(true);
});
