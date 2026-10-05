import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { boundedDownload, downloadPreview, offeredVersion } from "./preview-download.boundary.js";
import { sha256 } from "./manifest.js";

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});
const settings = {
  format: 1,
  repository: "school/marea",
  component: "student",
  channel: "preview",
  serverUrl: "https://school.test",
} as const;
const version = "0.1.0-preview.2";
const manifest = {
  format: 1,
  version,
  component: "student",
  target: "linux-x64",
  bun: "1.4.0",
  opentui: "0.5.10",
  commit: "a".repeat(40),
  files: [
    { path: "marea", executable: true, sha256: sha256(Buffer.from("binary")) },
    { path: "licenses/LICENSE", executable: false, sha256: sha256(Buffer.from("license")) },
  ],
};
const directory = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-preview-download-")));
  scratch.push(root);
  return root;
};

it("bounds streamed downloads and fails closed on status, missing body and oversized streams", async () => {
  expect(
    Buffer.from(
      await boundedDownload(() => Promise.resolve(new Response("abc")), "https://test", 3),
    ).toString(),
  ).toBe("abc");
  for (const response of [
    new Response(null, { status: 204 }),
    new Response("no", { status: 404 }),
    new Response("abcd"),
  ])
    await expect(
      boundedDownload(() => Promise.resolve(response), "https://test", 3),
    ).rejects.toThrow();
});

it("uses the school's exact version for students and the preview list for teachers", async () => {
  const fetcher = vi.fn(() =>
    Promise.resolve(
      Response.json({
        requestId: "request:preview-update",
        serverVersion: version,
        supportedProtocolVersions: ["0.1"],
        capabilities: [],
      }),
    ),
  );
  expect(await offeredVersion(settings, "0.1.0-preview.1", fetcher)).toBe(version);
  expect(fetcher).toHaveBeenCalledWith(
    "https://school.test/v1/capabilities",
    expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request:preview-update",
        clientVersion: "0.1.0-preview.1",
        supportedProtocolVersions: ["0.1"],
      }),
    }),
  );
  expect(
    await offeredVersion({ ...settings, serverUrl: undefined }, version, fetcher),
  ).toBeUndefined();
  const github = vi.fn(() =>
    Promise.resolve(Response.json([{ tag_name: `v${version}`, prerelease: true, draft: false }])),
  );
  expect(await offeredVersion({ ...settings, component: "server" }, version, github)).toBe(version);
  expect(github).toHaveBeenCalledWith(
    "https://api.github.com/repos/school/marea/releases?per_page=100",
    {
      headers: { accept: "application/vnd.github+json" },
      signal: expect.any(AbortSignal) as AbortSignal,
    },
  );
  await expect(
    offeredVersion(settings, version, () => Promise.reject(new Error("offline"))),
  ).rejects.toThrow("offline");
});

it("authenticates the inventory before downloading any selected path and checks every hash", async () => {
  const writes = vi.spyOn(filesystem, "writeFileSync").mockClear();
  const reads = vi.spyOn(filesystem, "readFileSync").mockClear();
  const root = directory();
  let verified = false;
  const fetcher = vi.fn((url: string) => {
    if (url.endsWith(".sigstore.json")) return Promise.resolve(new Response("bundle"));
    if (url.endsWith(".manifest.json")) return Promise.resolve(Response.json(manifest));
    expect(verified).toBe(true);
    return Promise.resolve(
      new Response(url.endsWith(sha256(Buffer.from("binary"))) ? "binary" : "license"),
    );
  });
  const verify = vi.fn(() => {
    verified = true;
  });
  expect(
    await downloadPreview(settings, version, "linux-x64", root, { fetch: fetcher, verify }),
  ).toEqual(manifest);
  for (const call of writes.mock.calls) expect(call[2]).toEqual({ flag: "wx", mode: 0o600 });
  expect(reads).toHaveBeenCalledWith(join(root, "manifest.json"), "utf8");
  expect(verify).toHaveBeenCalledWith(
    join(root, "manifest.json"),
    join(root, "manifest.sigstore.json"),
    `https://github.com/school/marea/.github/workflows/native-release-candidate.yml@refs/tags/v${version}`,
  );
  expect(statSync(join(root, "marea")).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "licenses/LICENSE")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "manifest.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "licenses")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(root, "marea"), "utf8")).toBe("binary");
  expect(readFileSync(join(root, "licenses/LICENSE"), "utf8")).toBe("license");
  const rejected = directory();
  await expect(
    downloadPreview(settings, version, "linux-x64", rejected, {
      fetch: fetcher,
      verify: () => {
        throw new Error("bad signature");
      },
    }),
  ).rejects.toThrow("bad signature");
  expect(readdirSync(rejected).sort()).toEqual(["manifest.json", "manifest.sigstore.json"]);
  await expect(
    downloadPreview(settings, version, "linux-x64", directory(), {
      fetch: (url) =>
        Promise.resolve(
          url.endsWith(".manifest.json") ? Response.json(manifest) : new Response("tampered"),
        ),
      verify,
    }),
  ).rejects.toThrow("checksum");
});

it("cancels streams on completion and rejects failed status even with a valid body", async () => {
  await expect(
    boundedDownload(() => Promise.resolve(new Response(null, { status: 204 })), "https://test", 3),
  ).rejects.toThrow("Release download unavailable");
  const cancel = vi.fn();
  const reader = {
    read: vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: Buffer.from("abc") })
      .mockResolvedValueOnce({ done: true }),
    cancel,
  };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => reader } });
  expect(Buffer.from(await boundedDownload(fetcher, "https://test", 3)).toString()).toBe("abc");
  expect(cancel).toHaveBeenCalledOnce();
  await expect(
    boundedDownload(() => Promise.resolve(new Response("abc", { status: 500 })), "https://test", 3),
  ).rejects.toThrow("Release download unavailable");
  await expect(
    boundedDownload(() => Promise.resolve(new Response("abcd")), "https://test", 3),
  ).rejects.toThrow("Release download exceeds size limit");
});
