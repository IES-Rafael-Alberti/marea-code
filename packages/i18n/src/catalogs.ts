import { ENGLISH_CATALOG } from "./catalogs/en.js";
import { SPANISH_CATALOG } from "./catalogs/es.js";
import { BASQUE_CATALOG } from "./catalogs/eu.js";
import type { CompleteCatalog, MessageKey } from "./keys.js";
import { assertCatalogIntegrity } from "./catalog-validation.js";

export type SpanishCatalog = CompleteCatalog;
export type EnglishCatalog = CompleteCatalog;
export type BasqueCatalog = CompleteCatalog;
export type OptionalCatalog = Readonly<Partial<Record<MessageKey, string>>>;

export interface TranslationCatalogs {
  readonly en: EnglishCatalog;
  readonly es: OptionalCatalog;
  readonly eu: OptionalCatalog;
}

export const CATALOGS: TranslationCatalogs = Object.freeze({
  en: ENGLISH_CATALOG,
  es: SPANISH_CATALOG,
  eu: BASQUE_CATALOG,
});

assertCatalogIntegrity({ en: ENGLISH_CATALOG, es: SPANISH_CATALOG, eu: BASQUE_CATALOG });
