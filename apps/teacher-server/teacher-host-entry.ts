#!/usr/bin/env bun
import { runTeacherHostMain } from "./src/platform/teacher-host/teacher-host-main.js";

process.exitCode = await runTeacherHostMain();
