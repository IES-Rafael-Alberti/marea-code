#!/usr/bin/env bun
import { runMain } from "./src/platform/operator-cli/main.js";

process.exitCode = await runMain();
