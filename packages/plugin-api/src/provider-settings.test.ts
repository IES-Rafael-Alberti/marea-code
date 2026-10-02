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
