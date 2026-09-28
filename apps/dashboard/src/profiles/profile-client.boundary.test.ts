import { expect, it, vi } from "vitest";
import {
  createProfileClient,
  ProfileRequestError,
  LegacyProfileModeError,
} from "./profile-client.boundary.js";
import { release, state, catalog, value } from "./profile.fixture.js";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";
const scope = { kind: "teacher" } as const;
const signal = new AbortController().signal;
const write = {
  scope,
  expectedRevision: null,
  expectedPersonalRevision: null,
  catalogRevision: release.revision,
};
it("uses exact authenticated POST contracts for all four operations and correlates responses", async () => {
  const fetch = vi.fn<DashboardFetch>().mockResolvedValue(new Response(JSON.stringify(state())));
  const client = createProfileClient(fetch, release, () => "request:fixture");
  expect(await client.read(scope, signal)).toEqual(state());
  expect(fetch.mock.lastCall).toEqual([
    "/api/v1/dashboard/profiles/read",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        requestId: "request:fixture",
        kind: "dashboard-profile-read",
        scope,
      }),
    }),
  ]);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(catalog())));
  expect(await client.catalog(scope, signal)).toEqual(catalog());
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(state())));
  await client.save(write, value, true, signal);
  expect(JSON.parse(fetch.mock.lastCall?.[1].body as string)).toMatchObject({
    ...write,
    kind: "dashboard-profile-save",
    value,
    discardUnavailable: true,
  });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(state())));
  await client.reset(write, signal);
  expect(fetch.mock.lastCall?.[0]).toBe("/api/v1/dashboard/profiles/reset");
});
it("limits bytes during streaming and rejects malformed, missing, crossed and failed responses", async () => {
  for (const response of [
    new Response(null),
    new Response(new Uint8Array([255])),
    new Response("{"),
    new Response(JSON.stringify({ ...state(), requestId: "request:other" })),
    new Response(JSON.stringify(state({ kind: "class", classId: "class:a" }))),
    new Response(" ".repeat(262145)),
  ]) {
    const client = createProfileClient(
      vi.fn().mockResolvedValue(response),
      release,
      () => "request:fixture",
    );
    await expect(client.read(scope, signal)).rejects.toThrow();
  }
  const client = createProfileClient(
    vi.fn().mockResolvedValue(new Response("", { status: 409 })),
    release,
  );
  await expect(client.read(scope, signal)).rejects.toBeInstanceOf(ProfileRequestError);
  const fetch = vi.fn<DashboardFetch>();
  const invalid = createProfileClient(fetch, release);
  await expect(
    invalid.save(write, { themeId: "org.marea.missing", modules: [] }, false, signal),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("joins split UTF-8 documents and cancels oversized streams", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(state()));
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 40));
        controller.enqueue(bytes.slice(40));
        controller.close();
      },
    }),
  );
  const client = createProfileClient(
    vi.fn().mockResolvedValue(response),
    release,
    () => "request:fixture",
  );
  expect(await client.read(scope, signal)).toEqual(state());
  const cancel = vi.fn();
  const large = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(262145));
      },
      cancel,
    }),
  );
  await expect(
    createProfileClient(vi.fn().mockResolvedValue(large), release).read(scope, signal),
  ).rejects.toThrow("too large");
  expect(cancel).toHaveBeenCalledOnce();
});
it("distinguishes safe response failures and accepts the exact response byte limit", async () => {
  const check = (response: Response) =>
    createProfileClient(vi.fn().mockResolvedValue(response), release, () => "request:fixture").read(
      scope,
      signal,
    );
  await expect(check(new Response(null))).rejects.toThrow("Missing profile response.");
  await expect(check(new Response("", { status: 401 }))).rejects.toThrow("Profile request failed.");
  await expect(
    check(new Response(JSON.stringify({ ...state(), requestId: "request:other" }))),
  ).rejects.toThrow("Profile response mismatch.");
  expect(await check(new Response(JSON.stringify(state()).padEnd(262144)))).toEqual(state());
});
it("counts UTF-8 request bytes, including JSON escaping, before sending a profile", async () => {
  const { validateProfileRequestSize } = await import("./profile-client.boundary.js");
  expect(() => {
    validateProfileRequestSize({ text: "a".repeat(65525) });
  }).not.toThrow();
  expect(() => {
    validateProfileRequestSize({ text: "a".repeat(65526) });
  }).toThrow("Profile request too large.");
  expect(() => {
    validateProfileRequestSize({ text: "é".repeat(32763) });
  }).toThrow("Profile request too large.");
});
it("detects a changed release before attempting to decode unknown plugin settings", async () => {
  const { ProfileCatalogMismatchError } = await import("./profile-client.boundary.js");
  const changed = {
    ...state(),
    catalogRevision: "a".repeat(64),
    effective: { themeId: "org.marea.future", modules: [] },
  };
  await expect(
    createProfileClient(
      vi.fn().mockResolvedValue(new Response(JSON.stringify(changed))),
      release,
    ).read(scope, signal),
  ).rejects.toBeInstanceOf(ProfileCatalogMismatchError);
});
it("enforces the transport limit independently of a faulty release codec", async () => {
  const fetch = vi.fn<DashboardFetch>();
  const parse = vi.spyOn(release.schemas.request, "parse").mockReturnValue({
    protocolVersion: "0.1",
    requestId: state().requestId,
    kind: "dashboard-profile-read",
    scope: { kind: "class", classId: "x".repeat(65537) },
  });
  try {
    await expect(createProfileClient(fetch, release).read(scope, signal)).rejects.toThrow(
      "Profile request too large.",
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
it("uses the public response codec mode for both revision preflight and complete decoding", async () => {
  const protocol = await import("@marea/protocol");
  const codec = vi.spyOn(protocol, "createDashboardProfileDocumentSchema");
  try {
    await createProfileClient(
      vi.fn().mockResolvedValue(new Response(JSON.stringify(state()))),
      release,
      () => "request:fixture",
    ).read(scope, signal);
    expect(codec.mock.calls.map((call) => call[1])).toEqual(["response", "response"]);
    await expect(
      createProfileClient(
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ ...state(), catalogRevision: "b".repeat(64) })),
          ),
        release,
      ).read(scope, signal),
    ).rejects.toThrow("Different dashboard catalog.");
  } finally {
    codec.mockRestore();
  }
});

it("recognizes only the authenticated explicit legacy-host marker, never ordinary failures", async () => {
  for (const [status, mode, legacy] of [
    [503, "legacy", true],
    [503, "other", false],
    [403, "legacy", false],
  ] as const) {
    const client = createProfileClient(
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status, headers: { "x-marea-profile-mode": mode } }),
        ),
      release,
    );
    await expect(client.read(scope, signal)).rejects.toBeInstanceOf(
      legacy ? LegacyProfileModeError : ProfileRequestError,
    );
  }
});
