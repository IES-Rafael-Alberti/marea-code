import { runCli } from "../src/cli.js";
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

process.exitCode = await runCli(process.argv.slice(2), SPIKE_COPY);
