import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { rsaKeys, signedToken } from "./google.fixture.js";
import {
  base64urlBytes,
  base64urlText,
  decodeJwt,
  signRs256,
  verifyRs256,
} from "./jwt.boundary.js";

describe("JWT boundary", () => {
  it("encodes base64url text and bytes without padding", () => {
    expect(base64urlText("ab?")).toBe("YWI_");
    expect(base64urlText("ñ")).toBe("w7E");
    expect(base64urlBytes(new Uint8Array([251, 255]))).toBe("-_8");
  });

  it("decodes and verifies an RS256 token only with the matching key", async () => {
    const keys = await rsaKeys();
    const other = await rsaKeys("key-2");
    const jwt = decodeJwt(await signedToken(keys, { sub: "1" }));
    expect(jwt.header).toEqual({ alg: "RS256", kid: "key-1", typ: "JWT" });
    expect(jwt.payload).toEqual({ sub: "1" });
    expect(await verifyRs256(jwt, keys.publicJwk)).toBe(true);
    expect(await verifyRs256(jwt, other.publicJwk)).toBe(false);
    const forged = decodeJwt(
      `${base64urlText(JSON.stringify(jwt.header))}.${base64urlText(JSON.stringify({ sub: "2" }))}.${base64urlBytes(jwt.signature)}`,
    );
    expect(await verifyRs256(forged, keys.publicJwk)).toBe(false);
  });

  it.each(["a.b", "a.b.c.d", "", "a.b.c d", " a.b.c", "a.b.c "])(
    "rejects a token that is not compact %j",
    (token) => {
      expect(() => decodeJwt(token)).toThrow(
        expect.objectContaining({
          code: "invalid-response",
          message: "The identity token is not compact.",
        }),
      );
    },
  );

  it.each([
    `${base64urlText("[]")}.${base64urlText("{}")}.c`,
    `${base64urlText("{}")}.${base64urlText("not json")}.c`,
  ])("rejects a malformed compact token %j", (token) => {
    expect(() => decodeJwt(token)).toThrow(
      expect.objectContaining({
        code: "invalid-response",
        message: "The identity token is malformed.",
      }),
    );
  });

  it("signs service account assertions with a PEM private key", async () => {
    const keys = await rsaKeys();
    const token = await signRs256({ iss: "marea" }, keys.pem);
    const jwt = decodeJwt(token);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.payload).toEqual({ iss: "marea" });
    expect(await verifyRs256(jwt, keys.publicJwk)).toBe(true);
    const imported = await webcrypto.subtle.importKey(
      "jwk",
      keys.publicJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(imported.type).toBe("public");
    await expect(
      signRs256({}, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"),
    ).rejects.toThrow();
  });
});
