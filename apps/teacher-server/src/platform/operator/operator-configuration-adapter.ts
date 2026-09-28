import type { TeachingOperatorConfiguration } from "../../teaching/configuration/dashboard-contracts.js";

export interface ParsedOperatorDocument {
  readonly version: 1;
  readonly forClass: TeachingOperatorConfiguration["forClass"];
}

export function createOperatorConfiguration(
  document: ParsedOperatorDocument,
): TeachingOperatorConfiguration {
  return { forClass: document.forClass };
}
