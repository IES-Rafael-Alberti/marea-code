import { afterEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));
vi.mock("node:fs", () => ports);
vi.mock("./manifest.js", async (load) => ({
  ...(await load<typeof import("./manifest.js")>()),
  sha256: () => "a".repeat(64),
}));
import { downloadPreview } from "./preview-download.boundary.js";
afterEach(() => vi.restoreAllMocks());
it("accepts the exact total byte budget and refuses the next authenticated file before writing it", async () => {
  const version = "0.1.0-preview.1";
  const files = Array.from({ length: 5 }, (_, i) => ({
    path: `part-${String(i)}`,
    sha256: "a".repeat(64),
    executable: false,
  }));
  const manifest = {
    format: 1,
    version,
    component: "student",
    target: "linux-x64",
    bun: "1.4.2",
    opentui: "0.5.10",
    commit: "b".repeat(40),
    files,
  };
  ports.readFileSync.mockImplementation(() => JSON.stringify(manifest));
  // Model authenticated 500 MB downloads without allocating multi-gigabyte test data.
  const concat = Buffer.concat.bind(Buffer);
  vi.spyOn(Buffer, "concat").mockImplementation((chunks) => {
    const bytes = concat(chunks);
    Object.defineProperty(bytes, "length", { value: 500_000_000 });
    return bytes;
  });
  const fetcher = () => Promise.resolve(new Response("part"));
  const settings = {
    format: 1,
    component: "student",
    channel: "preview",
    repository: "school/marea",
  } as const;
  await expect(
    downloadPreview(settings, version, "linux-x64", "/download", {
      fetch: fetcher,
      verify: () => undefined,
    }),
  ).rejects.toThrow("total size mismatch");
  expect(
    ports.writeFileSync.mock.calls.filter((call) => String(call[0]).includes("part-")),
  ).toHaveLength(4);
});
