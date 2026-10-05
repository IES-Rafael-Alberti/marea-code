import {
  findCandidates,
  includeSignatureTool,
  preparePreviewPublication,
} from "./preview-publish.ts";
import process from "node:process";

const [action, ...args] = process.argv.slice(2);
if (action === "include-tool" && args.length === 3) includeSignatureTool(...args);
else if (action === "prepare" && args.length === 4)
  preparePreviewPublication(findCandidates(args[0]), ...args.slice(1));
else
  throw new Error(
    "Use include-tool <candidate> <cosign> <license> or prepare <candidates> <output> <repository> <version>",
  );
