import { describe, expect, it } from "vitest";

import openRouterProviderPlugin from "./index.js";
import { DEFAULT_OPENROUTER_ENDPOINT, parseOpenRouterConfiguration } from "./configuration.js";

describe("OpenRouter configuration", () => {
  it("normalizes a server-owned credential and uses the fixed public endpoint", () => {
    expect(parseOpenRouterConfiguration({ apiKey: "  secret-key-with-safe-length  " })).toEqual({
      apiKey: "secret-key-with-safe-length",
      endpoint: DEFAULT_OPENROUTER_ENDPOINT,
    });
    expect(
      parseOpenRouterConfiguration({
        apiKey: "secret-key-with-safe-length",
        endpoint: "https://example.test/gateway",
      }).endpoint,
    ).toBe("https://example.test/gateway");
  });

  it.each(["", "x".repeat(15), "x".repeat(513)])("rejects invalid credentials", (apiKey) => {
    expect(() => parseOpenRouterConfiguration({ apiKey })).toThrow(
      expect.objectContaining({
        code: "authentication-failed",
        message: "The inference provider configuration is invalid.",
        retryable: false,
      }),
    );
  });

  it("accepts both credential length limits", () => {
    expect(parseOpenRouterConfiguration({ apiKey: "x".repeat(16) }).apiKey).toHaveLength(16);
    expect(parseOpenRouterConfiguration({ apiKey: "x".repeat(512) }).apiKey).toHaveLength(512);
  });

  it.each([
    "not a URL",
    "http://example.test/gateway",
    "https://user@example.test/gateway",
    "https://:secret@example.test/gateway",
    "https://example.test/gateway#fragment",
  ])("rejects an unsafe endpoint %s", (endpoint) => {
    expect(() =>
      parseOpenRouterConfiguration({ apiKey: "secret-key-with-safe-length", endpoint }),
    ).toThrow("The inference provider configuration is invalid.");
  });

  it("exports the executable manifest entry", () => {
    expect(openRouterProviderPlugin.manifest).toMatchObject({
      id: "org.marea.openrouter",
      capabilities: ["streaming", "tool-calls"],
    });
    const provider = openRouterProviderPlugin.create({
      apiKey: "secret-key-with-safe-length",
    });
    expect(typeof provider.stream).toBe("function");
  });
});
