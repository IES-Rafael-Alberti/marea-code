import { existsSync } from "node:fs";
import * as workerAsset from "@opentui/core/parser.worker" with { type: "file" };

/** Static file import is required by Bun 1.3.1; the upstream dynamic import is not embedded. */
export function requireParserAsset(): void {
  const workerPath = (workerAsset as { readonly default?: unknown }).default;
  if (typeof workerPath !== "string" || !existsSync(workerPath))
    throw new Error("The bundled Markdown parser is unavailable.");
}
