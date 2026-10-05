import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createIdentityProviderManifestSchema,
  parseIdentityProviderEntry,
} from "@marea/plugin-api";
import { describe, expect, it } from "vitest";

import plugin from "./index.js";
import {
  CLIENT_ID,
  DOMAIN,
  claims,
  fakeGoogle,
  json,
  rsaKeys,
  signedToken,
} from "./google.fixture.js";
import { DIRECTORY_GROUPS_ENDPOINT } from "./google-groups.js";
import { GOOGLE_CERTIFICATES_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "./google-oidc.js";
import { createGoogleWorkspaceProvider } from "./provider.js";

const signal = new AbortController().signal;
const base = { clientId: CLIENT_ID, clientSecret: "secret", domain: DOMAIN };
const ANA = { subject: "1", email: "ana@school.test", displayName: "Ana" };

describe("Google Workspace identity provider", () => {
  it("publishes the manifest of plugin.json and valid plugin-authored parts", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf8"),
    ) as object;
    expect(plugin.manifest).toEqual(createIdentityProviderManifestSchema().parse(manifest));
    expect(
      parseIdentityProviderEntry(plugin).descriptor.ruleKinds.map((kind) => kind.kind),
    ).toEqual(["email", "group"]);
    expect(plugin.create).toBe(createGoogleWorkspaceProvider);
  });

  it("signs a school student in through the authorization code and identity token", async () => {
    const keys = await rsaKeys();
    const google = fakeGoogle({
      [GOOGLE_TOKEN_ENDPOINT]: async () => json({ id_token: await signedToken(keys, claims()) }),
      [GOOGLE_CERTIFICATES_ENDPOINT]: () => json({ keys: [keys.publicJwk] }),
    });
    const provider = createGoogleWorkspaceProvider(base, google.runtime);
    expect(
      new URL(
        provider.authorizationUrl({
          redirectUri: "http://127.0.0.1:4321/callback",
          state: "s",
          nonce: "n",
          codeChallenge: "c",
        }),
      ).searchParams.get("hd"),
    ).toBe(DOMAIN);
    await expect(
      provider.complete({
        code: "4/code",
        redirectUri: "http://127.0.0.1:4321/callback",
        codeVerifier: "verifier",
        nonce: "nonce-1",
        signal,
      }),
    ).resolves.toEqual({
      subject: "1234567890",
      email: "ana@school.test",
      displayName: "Ana García",
    });
    await expect(
      provider.complete({
        code: "4/code",
        redirectUri: "http://127.0.0.1:4321/callback",
        codeVerifier: "verifier",
        nonce: "other",
        signal,
      }),
    ).rejects.toMatchObject({ code: "denied" });
  });

  it("accepts only addresses of the school domain, and groups only when configured", () => {
    const withoutGroups = createGoogleWorkspaceProvider(base, fakeGoogle({}).runtime);
    expect(withoutGroups.normalizeRule("email", "  Ana.Garcia+1@School.Test ")).toBe(
      "ana.garcia+1@school.test",
    );
    for (const value of [
      "ana@other.test",
      "ana",
      "ana@evilschool.test",
      "a b@school.test",
      "@school.test",
    ])
      expect(withoutGroups.normalizeRule("email", value)).toBeUndefined();
    expect(withoutGroups.normalizeRule("group", "1daw@school.test")).toBeUndefined();
    expect(withoutGroups.normalizeRule("domain", "ana@school.test")).toBeUndefined();
    const withGroups = createGoogleWorkspaceProvider(
      {
        ...base,
        serviceAccountEmail: "marea@project.iam.gserviceaccount.com",
        serviceAccountKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        adminEmail: "admin@school.test",
      },
      fakeGoogle({}).runtime,
    );
    expect(withGroups.normalizeRule("group", "1DAW@school.test")).toBe("1daw@school.test");
    expect(withGroups.normalizeRule("group", "1daw@other.test")).toBeUndefined();
    expect(withGroups.normalizeRule("domain", "ana@school.test")).toBeUndefined();
  });

  it("admits listed addresses without network calls and checks groups otherwise", async () => {
    const keys = await rsaKeys();
    const checked: string[] = [];
    const google = fakeGoogle({
      [GOOGLE_TOKEN_ENDPOINT]: () => json({ access_token: "a", expires_in: 3_600 }),
      [`${DIRECTORY_GROUPS_ENDPOINT}/1daw%40school.test/hasMember/ana%40school.test`]: () => {
        checked.push("1daw");
        return json({ isMember: false });
      },
      [`${DIRECTORY_GROUPS_ENDPOINT}/2daw%40school.test/hasMember/ana%40school.test`]: () => {
        checked.push("2daw");
        return json({ isMember: true });
      },
    });
    const provider = createGoogleWorkspaceProvider(
      {
        ...base,
        serviceAccountEmail: "marea@project.iam.gserviceaccount.com",
        serviceAccountKey: keys.pem,
        adminEmail: "admin@school.test",
      },
      google.runtime,
    );
    await expect(
      provider.admits(
        ANA,
        [
          { kind: "group", value: "1daw@school.test" },
          { kind: "email", value: "ana@school.test" },
        ],
        signal,
      ),
    ).resolves.toBe(true);
    expect(google.seen).toEqual([]);
    await expect(
      provider.admits(
        ANA,
        [
          { kind: "email", value: "bob@school.test" },
          { kind: "group", value: "1daw@school.test" },
          { kind: "group", value: "2daw@school.test" },
        ],
        signal,
      ),
    ).resolves.toBe(true);
    expect(checked).toEqual(["1daw", "2daw"]);
    await expect(
      provider.admits(
        ANA,
        [
          { kind: "group", value: "1daw@school.test" },
          { kind: "domain", value: "ana@school.test" },
        ],
        signal,
      ),
    ).resolves.toBe(false);
  });

  it("ignores group rules without group admission", async () => {
    const google = fakeGoogle({});
    const provider = createGoogleWorkspaceProvider(base, google.runtime);
    await expect(
      provider.admits(ANA, [{ kind: "group", value: "1daw@school.test" }], signal),
    ).resolves.toBe(false);
    expect(google.seen).toEqual([]);
  });
});
