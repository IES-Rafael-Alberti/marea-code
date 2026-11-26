import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sessionsMessages } from "./sessions-messages.js";
import { VersionMismatch } from "./version-mismatch.js";

const mismatch = { versionMismatch: { clientVersion: "0.1.0", serverVersion: "0.2.0" } };

describe("client version indication", () => {
  it.each([
    ["es", "Versión del cliente distinta: 0.1.0 (servidor 0.2.0)"],
    ["en", "Different client version: 0.1.0 (server 0.2.0)"],
    ["eu", "Bezeroaren bertsio desberdina: 0.1.0 (zerbitzaria 0.2.0)"],
  ] as const)("names both versions in %s", (locale, text) => {
    expect(
      renderToStaticMarkup(<VersionMismatch messages={sessionsMessages(locale)} run={mismatch} />),
    ).toBe(`<small class="session-version">${text}</small>`);
  });

  it.each([{}, null, undefined])("shows nothing for a session without a mismatch: %j", (run) => {
    expect(
      renderToStaticMarkup(<VersionMismatch messages={sessionsMessages("es")} run={run} />),
    ).toBe("");
  });
});
