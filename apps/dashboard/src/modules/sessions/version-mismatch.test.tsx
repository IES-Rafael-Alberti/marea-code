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

  it.each([
    ["es", "Versión del cliente distinta: Preview 49 o anterior (servidor 0.1.0-preview.50)"],
    ["en", "Different client version: Preview 49 or earlier (server 0.1.0-preview.50)"],
    [
      "eu",
      "Bezeroaren bertsio desberdina: Preview 49 edo lehenagokoa (zerbitzaria 0.1.0-preview.50)",
    ],
  ] as const)(
    "names a client that announced the old constant by its release in %s",
    (locale, text) => {
      const legacy = {
        versionMismatch: { clientVersion: "0.2.0", serverVersion: "0.1.0-preview.50" },
      };
      expect(
        renderToStaticMarkup(<VersionMismatch messages={sessionsMessages(locale)} run={legacy} />),
      ).toBe(`<small class="session-version">${text}</small>`);
    },
  );

  it.each([{}, null, undefined])("shows nothing for a session without a mismatch: %j", (run) => {
    expect(
      renderToStaticMarkup(<VersionMismatch messages={sessionsMessages("es")} run={run} />),
    ).toBe("");
  });
});
