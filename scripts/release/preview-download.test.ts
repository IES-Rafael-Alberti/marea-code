import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  boundedDownload,
  downloadPreview,
  offeredVersion,
  requiredPreviewVersion,
} from "./preview-download.boundary.js";
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
  bun: "1.4.2",
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

it("reports bounded streamed byte totals before the download finishes", async () => {
  const progress = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("abc"));
      controller.enqueue(Buffer.from("def"));
      controller.close();
    },
  });
  await boundedDownload(
    () => Promise.resolve(new Response(stream)),
    "https://test",
    6,
    {},
    progress,
  );
  expect(progress.mock.calls).toEqual([[3], [6]]);
});

it("reports signature verification, per-file streamed totals and authenticated completion", async () => {
  const binary = Buffer.alloc(1_572_864);
  const license = Buffer.alloc(262_144);
  const inventory = {
    ...manifest,
    files: manifest.files.map((file, index) => ({
      ...file,
      sha256: sha256(index === 0 ? binary : license),
    })),
  };
  const progress = { stage: vi.fn(), update: vi.fn() };
  const fetcher = (url: string) =>
    Promise.resolve(
      url.endsWith(".manifest.json")
        ? Response.json(inventory)
        : new Response(
            url.endsWith(".sigstore.json")
              ? "bundle"
              : url.endsWith(sha256(binary))
                ? binary
                : license,
          ),
    );
  const verify = vi.fn(() => {
    expect(progress.stage).toHaveBeenLastCalledWith("Verificando la firma de la versión...");
    expect(progress.update).not.toHaveBeenCalled();
  });
  await downloadPreview(settings, version, "linux-x64", directory(), {
    fetch: fetcher,
    verify,
    progress,
  });
  expect(progress.stage.mock.calls).toEqual([
    ["Obteniendo la información de la versión..."],
    ["Verificando la firma de la versión..."],
    ["Descargando 2 archivos de Marea..."],
    ["Descarga verificada: 2 archivos."],
  ]);
  expect(progress.update.mock.calls).toEqual([
    ["Descargando archivo 1/2: 0.0 MiB recibidos en total"],
    ["Descargando archivo 1/2: 1.5 MiB recibidos en total"],
    ["Descargando archivo 2/2: 1.5 MiB recibidos en total"],
    ["Descargando archivo 2/2: 1.8 MiB recibidos en total"],
  ]);
  progress.stage.mockClear();
  verify.mockImplementationOnce(() => {
    throw new Error("bad signature");
  });
  await expect(
    downloadPreview(settings, version, "linux-x64", directory(), {
      fetch: fetcher,
      verify,
      progress,
    }),
  ).rejects.toThrow("bad signature");
  expect(progress.stage.mock.calls).toEqual([
    ["Obteniendo la información de la versión..."],
    ["Verificando la firma de la versión..."],
  ]);
});

it("discovers recommendations independently of the school and keeps manual previews separate", async () => {
  const github = vi.fn(() =>
    Promise.resolve(
      Response.json({
        format: 1,
        available: version,
        recommended: { "0.1": { student: "0.1.0-preview.1", server: version } },
      }),
    ),
  );
  expect(await offeredVersion(settings, github)).toBe("0.1.0-preview.1");
  expect(await offeredVersion(settings, github, "available")).toBe(version);
  expect(await offeredVersion({ ...settings, component: "server" }, github)).toBe(version);
  expect(github).toHaveBeenCalledWith(
    "https://raw.githubusercontent.com/school/marea/marea-preview-channel/preview.json",
    {
      signal: expect.any(AbortSignal) as AbortSignal,
    },
  );
  await expect(
    offeredVersion(settings, () => Promise.reject(new Error("offline"))),
  ).rejects.toThrow("offline");
});

it("requires a school release only for incompatible protocols, never for a different software version", async () => {
  const response = {
    requestId: "request:preview-update",
    serverVersion: version,
    supportedProtocolVersions: ["0.1"],
    capabilities: [],
  };
  const fetcher = vi.fn(() => Promise.resolve(Response.json(response)));
  expect(await requiredPreviewVersion(settings, "0.1.0-preview.1", fetcher)).toBeUndefined();
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
  response.supportedProtocolVersions = ["2.0"];
  expect(await requiredPreviewVersion(settings, "0.1.0-preview.1", fetcher)).toBe(version);
  response.requestId = "request:unrelated";
  await expect(requiredPreviewVersion(settings, version, fetcher)).rejects.toThrow(
    "Unrelated capabilities response",
  );
  const calls = fetcher.mock.calls.length;
  expect(
    await requiredPreviewVersion({ ...settings, serverUrl: undefined }, version, fetcher),
  ).toBeUndefined();
  expect(
    await requiredPreviewVersion({ ...settings, component: "server" }, version, fetcher),
  ).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(calls);
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

it("bounds the static channel independently of the number or size of published release assets", async () => {
  const body = JSON.stringify({ format: 1, available: version, recommended: {} }).padEnd(
    65_536,
    " ",
  );
  expect(
    await offeredVersion(settings, () => Promise.resolve(new Response(body)), "available"),
  ).toBe(version);
  await expect(
    offeredVersion(settings, () => Promise.resolve(new Response(body + " ")), "available"),
  ).rejects.toThrow("size limit");
});
