import { describe, expect, it } from "vitest";

import {
  CLIENT_ID,
  DOMAIN,
  NOW_MS,
  claims,
  fakeGoogle,
  json,
  rsaKeys,
  signedToken,
  type RsaKeys,
} from "./google.fixture.js";
import {
  GOOGLE_CERTIFICATES_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleSigningKeys,
  exchangeGoogleCode,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from "./google-oidc.js";
import { googleJson, googleRequest } from "./google-http.boundary.js";

const settings = { clientId: CLIENT_ID, clientSecret: "secret", domain: DOMAIN, groups: undefined };
const signal = new AbortController().signal;
const authorization = {
  code: "4/code",
  redirectUri: "http://127.0.0.1:4321/callback",
  codeVerifier: "verifier",
  nonce: "nonce-1",
  signal,
};

function certificates(keys: readonly RsaKeys[], headers: Record<string, string> = {}) {
  return () => json({ keys: keys.map((key) => key.publicJwk) }, 200, headers);
}

describe("Google OpenID Connect", () => {
  it("asks for an account of the school domain with PKCE and a fresh nonce", () => {
    const url = new URL(
      googleAuthorizationUrl(settings, {
        redirectUri: "http://127.0.0.1:4321/callback",
        state: "state-1",
        nonce: "nonce-1",
        codeChallenge: "challenge",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: "http://127.0.0.1:4321/callback",
      response_type: "code",
      scope: "openid email profile",
      state: "state-1",
      nonce: "nonce-1",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      hd: DOMAIN,
      prompt: "select_account",
    });
  });

  it("exchanges the code with the client secret and verifier", async () => {
    const google = fakeGoogle({ [GOOGLE_TOKEN_ENDPOINT]: () => json({ id_token: "token" }) });
    await expect(exchangeGoogleCode(settings, google.runtime, authorization)).resolves.toBe(
      "token",
    );
    const request = google.seen[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(await request?.text()))).toEqual({
      code: "4/code",
      client_id: CLIENT_ID,
      client_secret: "secret",
      redirect_uri: "http://127.0.0.1:4321/callback",
      grant_type: "authorization_code",
      code_verifier: "verifier",
    });
  });

  it.each([
    [
      () => json({ error: "invalid_grant" }, 400),
      "denied",
      "Google refused the authorization code.",
    ],
    [() => new Response(null, { status: 401 }), "denied", "Google refused the authorization code."],
    [() => json({ error: "down" }, 500), "unavailable", "Google is temporarily unavailable."],
    [
      () => json({ access_token: "only" }),
      "invalid-response",
      "Google returned no identity token.",
    ],
    [() => new Response("not json"), "invalid-response", "Google returned an unreadable answer."],
    [
      () => {
        throw new TypeError("offline");
      },
      "unavailable",
      "Google could not be reached.",
    ],
  ] as const)("classifies a failed exchange (%#)", async (route, code, message) => {
    const google = fakeGoogle({ [GOOGLE_TOKEN_ENDPOINT]: route });
    await expect(exchangeGoogleCode(settings, google.runtime, authorization)).rejects.toMatchObject(
      {
        name: "IdentityProviderError",
        code,
        message,
      },
    );
  });

  it("bounds key and token requests with the caller's signal", async () => {
    const aborted = AbortSignal.abort();
    const google = fakeGoogle({
      [GOOGLE_CERTIFICATES_ENDPOINT]: (request) => {
        if (request.signal.aborted) throw new TypeError("aborted");
        return json({ keys: [] });
      },
      [GOOGLE_TOKEN_ENDPOINT]: (request) => {
        if (request.signal.aborted) throw new TypeError("aborted");
        return json({ id_token: "token" });
      },
    });
    await expect(new GoogleSigningKeys(google.runtime).key("key-1", aborted)).rejects.toMatchObject(
      {
        code: "unavailable",
      },
    );
    await expect(
      exchangeGoogleCode(settings, google.runtime, { ...authorization, signal: aborted }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("passes requests through and reads JSON bodies", async () => {
    const google = fakeGoogle({ "https://x.test/": () => new Response("{}", { status: 499 }) });
    const response = await googleRequest(google.runtime, new Request("https://x.test/"));
    expect(response.status).toBe(499);
    expect(await googleJson(json({ a: 1 }))).toEqual({ a: 1 });
  });

  it("caches signing keys as long as Google allows and refreshes for new keys", async () => {
    const first = await rsaKeys("key-1");
    const second = await rsaKeys("key-2");
    let published: readonly RsaKeys[] = [first];
    const google = fakeGoogle({
      [GOOGLE_CERTIFICATES_ENDPOINT]: () =>
        certificates(published, { "cache-control": "public, max-age=100, must-revalidate" })(),
    });
    const keys = new GoogleSigningKeys(google.runtime);
    expect(await keys.key("key-1", signal)).toMatchObject({ kid: "key-1" });
    expect(await keys.key("key-1", signal)).toMatchObject({ kid: "key-1" });
    expect(google.seen).toHaveLength(1);
    published = [first, second];
    expect(await keys.key("key-2", signal)).toMatchObject({ kid: "key-2" });
    expect(google.seen).toHaveLength(2);
    google.clock.now = NOW_MS + 99_999;
    await keys.key("key-1", signal);
    expect(google.seen).toHaveLength(2);
    google.clock.now = NOW_MS + 100_000;
    await keys.key("key-1", signal);
    expect(google.seen).toHaveLength(3);
    await expect(keys.key("key-3", signal)).rejects.toMatchObject({
      code: "invalid-response",
      message: "Google did not publish the token key.",
    });
  });

  it("caches keys for an hour without a usable max-age", async () => {
    const google = fakeGoogle({ [GOOGLE_CERTIFICATES_ENDPOINT]: certificates([await rsaKeys()]) });
    const keys = new GoogleSigningKeys(google.runtime);
    await keys.key("key-1", signal);
    google.clock.now = NOW_MS + 3_599_999;
    await keys.key("key-1", signal);
    expect(google.seen).toHaveLength(1);
    google.clock.now = NOW_MS + 3_600_000;
    await keys.key("key-1", signal);
    expect(google.seen).toHaveLength(2);
  });

  it.each([
    () => json({ keys: [] }),
    () => json({ keys: [{ kid: "key-1", kty: "EC" }] }),
    () => json({ keys: [{ kty: "RSA" }] }),
    () =>
      json({
        keys: Array.from({ length: 17 }, (_, index) => ({ kid: String(index), kty: "RSA" })),
      }),
    () => json({ error: true }, 404),
  ])("rejects unusable signing keys", async (route) => {
    const keys = new GoogleSigningKeys(
      fakeGoogle({ [GOOGLE_CERTIFICATES_ENDPOINT]: route }).runtime,
    );
    await expect(keys.key("key-1", signal)).rejects.toMatchObject({
      code: "invalid-response",
      message: "Google keys are unusable.",
    });
  });

  describe("identity token verification", () => {
    async function verify(payload: object, header?: object, keyOverride?: RsaKeys) {
      const keys = await rsaKeys();
      const google = fakeGoogle({ [GOOGLE_CERTIFICATES_ENDPOINT]: certificates([keys]) });
      const token = await signedToken(
        keyOverride ?? keys,
        payload,
        header ?? { alg: "RS256", kid: "key-1" },
      );
      return verifyGoogleIdToken(
        settings,
        new GoogleSigningKeys(google.runtime),
        google.runtime,
        token,
        "nonce-1",
        signal,
      );
    }

    it("returns the stable subject and lowercase address of a valid school account", async () => {
      await expect(verify(claims())).resolves.toEqual({
        subject: "1234567890",
        email: "ana@school.test",
        displayName: "Ana García",
      });
      await expect(
        verify(claims({ iss: "accounts.google.com", name: undefined })),
      ).resolves.toEqual({
        subject: "1234567890",
        email: "ana@school.test",
        displayName: "",
      });
      await expect(
        verify(claims({ exp: NOW_MS / 1_000 - 59, iat: NOW_MS / 1_000 + 60 })),
      ).resolves.toMatchObject({ subject: "1234567890" });
    });

    it.each([[{ alg: "HS256", kid: "key-1" }], [{ alg: "RS256" }], [{ alg: "RS256", kid: 1 }]])(
      "rejects a token not signed with a Google key %j",
      async (header) => {
        await expect(verify(claims(), header)).rejects.toMatchObject({
          code: "invalid-response",
          message: "The identity token is not signed with a Google key.",
        });
      },
    );

    it("rejects a token signed by another key", async () => {
      await expect(verify(claims(), undefined, await rsaKeys())).rejects.toMatchObject({
        code: "invalid-response",
        message: "The identity token signature is invalid.",
      });
    });

    it.each([
      { email_verified: false },
      { email_verified: "true" },
      { hd: undefined },
      { sub: "" },
      { email: "a@" },
      { name: "x".repeat(241) },
      { exp: "later" },
      { nonce: undefined },
      { aud: [CLIENT_ID] },
      { iss: 1 },
    ])("denies a token without verified school claims %j", async (override) => {
      await expect(verify(claims(override))).rejects.toMatchObject({
        code: "denied",
        message: "The identity token lacks a verified address.",
      });
    });

    it.each([
      { iss: "https://evil.test" },
      { aud: "other-client" },
      { nonce: "nonce-2" },
      { exp: NOW_MS / 1_000 - 60 },
      { iat: NOW_MS / 1_000 + 61 },
      { hd: "other.test" },
      { email: "ana@other.test" },
      { email: "ana@evilschool.test" },
    ])("denies a token for another audience, session or school %j", async (override) => {
      await expect(verify(claims(override))).rejects.toMatchObject({
        code: "denied",
        message: "The identity token is not valid for this school.",
      });
    });
  });
});
