import assert from "node:assert/strict";
import * as zlib from "node:zlib";
vi.mock("node:zlib", { spy: true });
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { downloadPreview, type PreviewFetch } from "./preview-download.boundary.js";
import { sha256 } from "./manifest.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-transfer-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source);
  mkdirSync(destination);
  const bodies = new Map([
    ["cosign", Buffer.from("signature verifier")],
    ["marea-install", Buffer.from("bootstrap installer")],
    ["marea", Buffer.alloc(4096, "client")],
  ]);
  const manifest = {
    format: 1,
    version: "0.1.0-preview.27",
    component: "student",
    target: "linux-x64",
    bun: "1.4.2",
    opentui: "0.5.10",
    commit: "a".repeat(40),
    files: [...bodies].map(([path, bytes]) => ({ path, executable: true, sha256: sha256(bytes) })),
  };
  const artifacts = new Map(
    [...bodies.values()].map((bytes) => [`sha256-${sha256(bytes)}`, bytes]),
  );
  const fetch = vi.fn<PreviewFetch>((url) => {
    if (url.endsWith(".manifest.json")) return Promise.resolve(Response.json(manifest));
    if (url.endsWith(".sigstore.json")) return Promise.resolve(new Response("signed bundle"));
    const name = url.split("/").at(-1) ?? "";
    const body = artifacts.get(name.replace(/\.gz$/, ""));
    if (!body) throw new Error("Unexpected download");
    return Promise.resolve(new Response(name.endsWith(".gz") ? zlib.gzipSync(body) : body));
  });
  const progress = { stage: vi.fn(), update: vi.fn() };
  const verify = vi.fn();
  const run = (showProgress = true) =>
    downloadPreview(
      { format: 1, repository: "school/marea", component: "student", channel: "preview" },
      manifest.version,
      manifest.target,
      destination,
      { fetch, verify, ...(showProgress ? { progress } : {}), reuseDirectory: source },
    );
  return { source, destination, bodies, artifacts, manifest, fetch, progress, verify, run };
}

it("reuses both bootstrap programs and downloads only the compressed client with an expansion bound", async () => {
  const f = fixture();
  for (const name of ["cosign", "marea-install"]) {
    const body = f.bodies.get(name);
    assert.ok(body);
    writeFileSync(join(f.source, name), body);
  }
  const inflate = vi.spyOn(zlib, "gunzipSync").mockClear();
  await f.run();
  const client = f.manifest.files[2];
  assert.ok(client);
  expect(f.fetch.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
    "student-linux-x64.manifest.json",
    "student-linux-x64.manifest.json.sigstore.json",
    `sha256-${client.sha256}.gz`,
  ]);
  expect(inflate).toHaveBeenCalledWith(expect.any(Uint8Array), { maxOutputLength: 512_000_000 });
  for (const [name, bytes] of f.bodies)
    expect(readFileSync(join(f.destination, name))).toEqual(bytes);
  expect(f.progress.stage).toHaveBeenCalledWith(
    "Reutilizados 2 archivos verificados, sin descargarlos de nuevo.",
  );
  expect(f.progress.update.mock.calls.at(-1)).toEqual([
    "Descargando archivo 3/3: 0.0 MiB recibidos en total",
  ]);
});

it.each([true, false])(
  "reuses an unchanged installed release without linking, with progress=%s",
  async (showProgress) => {
    const f = fixture();
    for (const [name, bytes] of f.bodies) writeFileSync(join(f.source, name), bytes);
    await f.run(showProgress);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    writeFileSync(join(f.source, "marea"), "changed after verification");
    expect(readFileSync(join(f.destination, "marea"))).toEqual(f.bodies.get("marea"));
    if (showProgress)
      expect(f.progress.stage).toHaveBeenCalledWith(
        "Reutilizados 3 archivos verificados, sin descargarlos de nuevo.",
      );
  },
);

it("redownloads changed cache entries, and accepts legacy raw assets only when gzip is absent", async () => {
  const f = fixture();
  for (const [name] of f.bodies) writeFileSync(join(f.source, name), "corrupt");
  const original = f.fetch.getMockImplementation();
  assert.ok(original);
  const cancelled = vi.fn();
  f.fetch.mockImplementation((url, init) =>
    url.endsWith(".gz")
      ? Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }), { status: 404 }))
      : original(url, init),
  );
  await f.run();
  expect(f.fetch).toHaveBeenCalledTimes(8);
  expect(cancelled).toHaveBeenCalledTimes(3);
  expect(f.progress.stage).not.toHaveBeenCalledWith(expect.stringContaining("Reutilizados"));
  for (const [name, bytes] of f.bodies)
    expect(readFileSync(join(f.destination, name))).toEqual(bytes);
});

it.each(["invalid gzip", "wrong digest", "http denied"])(
  "fails closed on %s without raw fallback",
  async (failure) => {
    const f = fixture();
    const original = f.fetch.getMockImplementation();
    assert.ok(original);
    f.fetch.mockImplementation((url, init) =>
      url.endsWith(".gz")
        ? Promise.resolve(
            new Response(failure === "wrong digest" ? zlib.gzipSync("tampered") : "invalid", {
              status: failure === "http denied" ? 403 : 200,
            }),
          )
        : original(url, init),
    );
    await expect(f.run()).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(3);
  },
);

it("never uses cached artifacts before the new inventory signature is authenticated", async () => {
  const f = fixture();
  for (const [name, bytes] of f.bodies) writeFileSync(join(f.source, name), bytes);
  f.verify.mockImplementation(() => {
    throw new Error("signature rejected");
  });
  await expect(f.run()).rejects.toThrow("signature rejected");
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.progress.stage).not.toHaveBeenCalledWith(expect.stringContaining("Reutilizados"));
});
