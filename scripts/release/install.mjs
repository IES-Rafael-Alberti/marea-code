import process from "node:process";
import { installerMain } from "./installer-entry.ts";
await installerMain(process.argv.slice(2));
