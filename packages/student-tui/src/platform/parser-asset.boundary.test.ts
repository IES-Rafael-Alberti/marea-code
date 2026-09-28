import { expect, it, vi } from "vitest";
const asset = vi.hoisted((): { path: unknown } => ({ path: "/embedded/parser.worker.js" }));
const exists = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ existsSync: exists }));
vi.mock("@opentui/core/parser.worker", () => ({
  get default() {
    return asset.path;
  },
}));
import { requireParserAsset } from "./parser-asset.boundary.js";
it("requires the statically embedded worker before opening the terminal", () => {
  exists.mockReturnValue(true);
  requireParserAsset();
  expect(exists).toHaveBeenLastCalledWith("/embedded/parser.worker.js");
  exists.mockReturnValue(false);
  expect(requireParserAsset).toThrow("The bundled Markdown parser is unavailable.");
});

it("refuses a loader that did not supply a file path", () => {
  exists.mockReturnValue(true);
  asset.path = undefined;
  expect(requireParserAsset).toThrow("The bundled Markdown parser is unavailable.");
  asset.path = "/embedded/parser.worker.js";
});
