import type { StudentTuiCopy } from "../src/contracts.js";

export const TEST_COPY: StudentTuiCopy = Object.freeze({
  controls: "Esc: cancel · Ctrl+C: interrupt · q: quit",
  emptyResponse: "No streamed text",
  errors: Object.freeze({ nonInteractive: "n", rendererFailed: "r", unexpected: "u" }),
  statuses: Object.freeze({
    cancelled: "Stopped",
    complete: "Finished",
    ready: "Prepared",
    streaming: "Live",
  }),
  title: "Synthetic screen",
});
