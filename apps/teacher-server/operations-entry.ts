#!/usr/bin/env bun
import { runOperationsMain } from "./src/platform/operations-cli/operations-main.js";

process.exitCode = await runOperationsMain();
