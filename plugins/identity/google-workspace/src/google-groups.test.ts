import { describe, expect, it } from "vitest";

import { NOW_MS, fakeGoogle, json, rsaKeys } from "./google.fixture.js";
import { DIRECTORY_GROUPS_ENDPOINT, GROUP_MEMBER_SCOPE, GoogleGroups } from "./google-groups.js";
import { GOOGLE_TOKEN_ENDPOINT } from "./google-oidc.js";
import { decodeJwt, verifyRs256 } from "./jwt.boundary.js";

const signal = new AbortController().signal;
const membership = `${DIRECTORY_GROUPS_ENDPOINT}/1daw%40school.test/hasMember/ana%40school.test`;

async function groups(routes: Parameters<typeof fakeGoogle>[0]) {
  const keys = await rsaKeys();
  const google = fakeGoogle(routes);
  return {
    keys,
    google,
    groups: new GoogleGroups(
      {
        serviceAccountEmail: "marea@project.iam.gserviceaccount.com",
        serviceAccountKey: keys.pem,
        adminEmail: "admin@school.test",
      },
      google.runtime,
    ),
  };
}

const token = () => json({ access_token: "access-1", expires_in: 3_600 });

describe("Google group admission", () => {
  it("asks the directory as the delegated administrator with a read-only scope", async () => {
    const test = await groups({
      [GOOGLE_TOKEN_ENDPOINT]: token,
      [membership]: () => json({ isMember: true }),
    });
    await expect(
      test.groups.hasMember("1daw@school.test", "ana@school.test", signal),
    ).resolves.toBe(true);
    const [grant, check] = test.google.seen;
    const form = Object.fromEntries(new URLSearchParams(await grant?.text()));
    expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(grant?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const assertion = decodeJwt(String(form.assertion));
    expect(assertion.payload).toEqual({
      iss: "marea@project.iam.gserviceaccount.com",
      sub: "admin@school.test",
      scope: GROUP_MEMBER_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: NOW_MS / 1_000,
      exp: NOW_MS / 1_000 + 3_600,
    });
    expect(await verifyRs256(assertion, test.keys.publicJwk)).toBe(true);
    expect(check?.url).toBe(membership);
    expect(check?.headers.get("authorization")).toBe("Bearer access-1");
  });

  it("reuses the access token until a minute before it expires", async () => {
    const test = await groups({
      [GOOGLE_TOKEN_ENDPOINT]: token,
      [membership]: () => json({ isMember: false }),
    });
    await test.groups.hasMember("1daw@school.test", "ana@school.test", signal);
    test.google.clock.now = NOW_MS + 3_539_999;
    await test.groups.hasMember("1daw@school.test", "ana@school.test", signal);
    expect(
      test.google.seen.filter((request) => request.url === GOOGLE_TOKEN_ENDPOINT),
    ).toHaveLength(1);
    test.google.clock.now = NOW_MS + 3_540_000;
    await expect(
      test.groups.hasMember("1daw@school.test", "ana@school.test", signal),
    ).resolves.toBe(false);
    expect(
      test.google.seen.filter((request) => request.url === GOOGLE_TOKEN_ENDPOINT),
    ).toHaveLength(2);
  });

  it.each([
    () => json({ error: true }, 400),
    () => json({ error: true }, 404),
    () => new Response(null, { status: 404 }),
  ])("treats an unknown group or member as no membership", async (route) => {
    const test = await groups({
      [GOOGLE_TOKEN_ENDPOINT]: token,
      [membership]: route,
    });
    await expect(
      test.groups.hasMember("1daw@school.test", "ana@school.test", signal),
    ).resolves.toBe(false);
  });

  it.each([
    [() => json({ error: true }, 403), "Google group membership is unavailable."],
    [() => json({ isMember: "yes" }), "Google group membership is unavailable."],
    [() => json({ error: true }, 503), "Google is temporarily unavailable."],
  ] as const)("fails closed when membership cannot be read", async (route, message) => {
    const test = await groups({ [GOOGLE_TOKEN_ENDPOINT]: token, [membership]: route });
    await expect(
      test.groups.hasMember("1daw@school.test", "ana@school.test", signal),
    ).rejects.toMatchObject({ code: "unavailable", message });
  });

  it.each([
    () => json({ error: "unauthorized_client" }, 401),
    () => json({ access_token: "x" }),
    () => json({ access_token: "x", expires_in: 0 }),
  ])("fails closed when the service account is refused", async (route) => {
    const test = await groups({ [GOOGLE_TOKEN_ENDPOINT]: route });
    await expect(
      test.groups.hasMember("1daw@school.test", "ana@school.test", signal),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Google refused the service account.",
    });
  });
});
