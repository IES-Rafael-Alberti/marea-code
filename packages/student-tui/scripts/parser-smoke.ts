import { getTreeSitterClient } from "@opentui/core";
import { requireParserAsset } from "../src/platform/parser-asset.boundary.js";

requireParserAsset();
const client = getTreeSitterClient();
try {
  const result = await client.highlightOnce("**A student message**", "markdown");
  if (
    result.error !== undefined ||
    !result.highlights?.some((entry) => entry[2] === "markup.strong")
  )
    throw new Error("Compiled Markdown highlighting did not produce strong text.");
  process.stdout.write("Compiled Markdown parser: pass\n");
} finally {
  await client.destroy();
}
