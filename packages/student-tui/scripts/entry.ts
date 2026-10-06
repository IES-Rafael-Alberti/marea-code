import { writeFileSync } from "node:fs";
import { runCli } from "../src/cli.js";
import { startStudentTui } from "../src/start.js";
import type { StudentTuiCopy } from "../src/contracts.js";

const SPIKE_COPY: StudentTuiCopy = Object.freeze({
  controls: "Esc: cancel task · Ctrl+C: interrupt · q: quit",
  emptyResponse: "Waiting for streamed text…",
  errors: Object.freeze({
    nonInteractive: "This compatibility spike requires an interactive terminal.",
    rendererFailed: "The compatibility spike could not initialize OpenTUI.",
    unexpected: "The compatibility spike failed during startup.",
  }),
  statuses: Object.freeze({
    cancelled: "Task cancelled",
    complete: "Stream complete",
    ready: "Ready",
    streaming: "Streaming",
  }),
  title: "Marea · OpenTUI compatibility spike",
});

process.exitCode = await runCli(process.argv.slice(2), SPIKE_COPY, {
  async start(copy) {
    const session = await startStudentTui(copy);
    // A painted first frame can precede the session's keyboard binding.
    // Use an out-of-band marker: ConPTY can coalesce text overwritten by a frame.
    const readyFile = process.env.MAREA_TUI_READY_FILE;
    if (readyFile !== undefined) writeFileSync(readyFile, "ready", { flag: "wx", mode: 0o600 });
    return session;
  },
  writeError: (message) => {
    process.stderr.write(`${message}\n`);
  },
  writeOutput: (message) => {
    process.stdout.write(`${message}\n`);
  },
});
