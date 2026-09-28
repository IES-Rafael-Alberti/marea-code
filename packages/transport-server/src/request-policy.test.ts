import { describe, expect, it } from "vitest";

import { RequestPolicy } from "./request-policy.js";

function policy(): RequestPolicy {
  return new RequestPolicy({
    allowedHosts: ["example.test:8443", "[::1]:8443"],
    allowedOrigins: ["https://teacher.example", "http://localhost:3000"],
  });
}

function request(
  host: string | null = "example.test:8443",
  origin: string | null = "https://teacher.example",
  path = "/stream",
): Request {
  const headers = new Headers();
  if (host !== null) {
    headers.set("host", host);
  }
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return new Request(`https://example.test${path}`, { headers });
}

describe("request policy", () => {
  it("accepts only a configured normalized authority and origin", () => {
    expect(policy().evaluate(request())).toEqual({ allowed: true });
    expect(policy().evaluate(request("[::1]:8443", "http://localhost:3000"))).toEqual({
      allowed: true,
    });
    expect(policy().evaluate(request("EXAMPLE.TEST:8443"))).toEqual({ allowed: true });
  });

  it("preserves the port as part of the allowed authority", () => {
    expect(policy().evaluate(request("example.test:9999"))).toEqual({ allowed: false });
    expect(policy().evaluate(request("example.test"))).toEqual({ allowed: false });

    const defaultPortPolicy = new RequestPolicy({
      allowedHosts: ["example.test:80"],
      allowedOrigins: ["https://teacher.example"],
    });
    expect(defaultPortPolicy.evaluate(request("example.test:80"))).toEqual({ allowed: true });
    expect(defaultPortPolicy.evaluate(request("example.test"))).toEqual({ allowed: false });
  });

  it("requires both routing headers and rejects every query", () => {
    expect(policy().evaluate(request(null))).toEqual({ allowed: false });
    expect(policy().evaluate(request("example.test:8443", null))).toEqual({ allowed: false });
    expect(policy().evaluate(request(null, null))).toEqual({ allowed: false });
    expect(policy().evaluate(request(null, null, "/stream?access_token=secret"))).toEqual({
      allowed: false,
    });
    expect(policy().evaluate(request(null, "https://teacher.example"))).toEqual({
      allowed: false,
    });

    const requestTargetPolicy = new RequestPolicy({
      allowedHosts: ["example.test"],
      allowedOrigins: ["https://example.test"],
    });
    expect(requestTargetPolicy.evaluate(request(null, "https://example.test"))).toEqual({
      allowed: false,
    });
    expect(requestTargetPolicy.evaluate(request("example.test", null))).toEqual({
      allowed: false,
    });
  });

  it("supports product GET queries and non-browser bearer clients explicitly", () => {
    expect(
      policy().evaluate(request("example.test:8443", null, "/dashboard?limit=50"), {
        allowSearch: true,
        requireOrigin: false,
      }),
    ).toEqual({ allowed: true });
    expect(policy().evaluate(request("example.test:8443", null), { requireOrigin: true })).toEqual({
      allowed: false,
    });
    expect(
      policy().evaluate(request("example.test:8443", "https://other.example"), {
        allowSearch: true,
      }),
    ).toEqual({ allowed: false });
  });

  it("rejects malformed and unlisted request values", () => {
    expect(policy().evaluate(request("bad host"))).toEqual({ allowed: false });
    expect(policy().evaluate(request("example.test:8443", "not-an-origin"))).toEqual({
      allowed: false,
    });
    expect(policy().evaluate(request("other.test:8443"))).toEqual({ allowed: false });
    expect(policy().evaluate(request("example.test:8443", "https://other.example"))).toEqual({
      allowed: false,
    });
  });

  it.each([
    { allowedHosts: [], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test:8443"], allowedOrigins: [] },
    { allowedHosts: ["user@example.test"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: [":secret@example.test"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test/path"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test?query"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test#hash"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["bad host"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["["], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test:"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test:080"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["[::1]:"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test "], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test\t"], allowedOrigins: ["https://teacher.example"] },
    { allowedHosts: ["example.test"], allowedOrigins: ["ftp://teacher.example"] },
    { allowedHosts: ["example.test"], allowedOrigins: ["https://teacher.example/path"] },
    { allowedHosts: ["example.test"], allowedOrigins: ["HTTPS://TEACHER.EXAMPLE"] },
    { allowedHosts: ["example.test"], allowedOrigins: ["not-an-origin"] },
  ])("rejects an invalid configured policy: $allowedHosts $allowedOrigins", (configured) => {
    expect(() => new RequestPolicy(configured)).toThrow(
      "Transport policy contains an invalid host or origin.",
    );
  });
});
