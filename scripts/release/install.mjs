import process from "node:process";
import { installerMain } from "./installer-entry.ts";
import { installerExitCode } from "./installer-cli.boundary.ts";
const failure = await installerExitCode(() => installerMain(process.argv.slice(2)));
if (failure !== 0) process.exitCode = failure;
