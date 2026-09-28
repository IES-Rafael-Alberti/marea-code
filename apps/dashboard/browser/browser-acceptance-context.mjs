/* global console, process, window */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

/** Launches headless Chromium and closes it when the proof runner is signalled. */
export async function launchAcceptanceBrowser() {
  const browser = await chromium.launch({ headless: true });
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      void browser.close().finally(() => process.exit(code));
    });
  }
  return browser;
}

/** Creates an English context that reports unhandled rejections and CSP violations. */
export async function newDiagnosticContext(browser) {
  const context = await browser.newContext({ locale: "en-US" });
  await context.addInitScript(() => {
    window.addEventListener("unhandledrejection", () =>
      console.error("UNHANDLED_BROWSER_REJECTION"),
    );
    window.addEventListener("securitypolicyviolation", (event) =>
      console.error(`CSP_VIOLATION:${event.effectiveDirective}:${event.blockedURI}`),
    );
  });
  return context;
}
