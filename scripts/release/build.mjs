import process from "node:process";
import { buildCandidate } from "./build.ts";
process.stdout.write(`${buildCandidate(process.argv.slice(2))}\n`);
