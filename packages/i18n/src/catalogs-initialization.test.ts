import { expect, it, vi } from "vitest";

import { assertCatalogIntegrity } from "./catalog-validation.js";
import { ENGLISH_CATALOG } from "./catalogs/en.js";
import { SPANISH_CATALOG } from "./catalogs/es.js";
import { BASQUE_CATALOG } from "./catalogs/eu.js";

vi.mock("./catalog-validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog-validation.js")>();
  return { ...actual, assertCatalogIntegrity: vi.fn(actual.assertCatalogIntegrity) };
});

it("validates all bundled catalogs during initialization", async () => {
  const { CATALOGS } = await import("./catalogs.js");
  expect(CATALOGS).toEqual({ en: ENGLISH_CATALOG, es: SPANISH_CATALOG, eu: BASQUE_CATALOG });
  expect(assertCatalogIntegrity).toHaveBeenCalledExactlyOnceWith({
    en: ENGLISH_CATALOG,
    es: SPANISH_CATALOG,
    eu: BASQUE_CATALOG,
  });
});
