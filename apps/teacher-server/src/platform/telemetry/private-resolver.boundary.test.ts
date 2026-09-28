import {
  chmodSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { privateTelemetryResolver } from "./private-resolver.boundary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-telemetry-")));
  roots.push(root);
  mkdirSync(join(root, "config"), { mode: 0o700 });
  const path = join(root, "config", "telemetry-otlp.json");
  const write = (value: unknown) => {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  };
  return { root, path, write, resolver: privateTelemetryResolver(root) };
}
const connection = {
  endpoint: "https://collector.invalid/base",
  headers: { authorization: "synthetic-secret" },
};
it("reads only owner-private bounded connection files without exposing failures", async () => {
  const f = fixture();
  f.write(connection);
  await expect(f.resolver.resolve("otlp", new AbortController().signal)).resolves.toEqual(
    connection,
  );
  const langfuse = {
    endpoint: "https://langfuse.invalid",
    publicKey: "synthetic-public",
    secretKey: "synthetic-secret",
  };
  writeFileSync(join(f.root, "config", "telemetry-langfuse.json"), JSON.stringify(langfuse), {
    mode: 0o600,
  });
  await expect(f.resolver.resolve("langfuse", new AbortController().signal)).resolves.toEqual(
    langfuse,
  );
});
it.each([
  "http://127.0.0.1:4318",
  "http://localhost:3000",
  "https://user:secret@collector.invalid",
  "https://user@collector.invalid",
  "https://:secret@collector.invalid",
  "https://collector.invalid?key=secret",
  "https://collector.invalid#secret",
  "not-a-url",
])("rejects unsafe endpoints including loopback: %s", async (endpoint) => {
  const f = fixture();
  f.write({ ...connection, endpoint });
  await expect(f.resolver.resolve("otlp", new AbortController().signal)).rejects.toMatchObject({
    message: "Telemetry exporter operation failed.",
    code: "unavailable",
  });
});
it.each(["missing", "public", "directory", "symlink", "oversize", "json", "cancelled"])(
  "rejects %s private inputs safely",
  async (kind) => {
    const f = fixture();
    if (kind !== "missing") f.write(connection);
    if (kind === "public") chmodSync(f.path, 0o644);
    if (kind === "directory") {
      rmSync(f.path);
      mkdirSync(f.path);
    }
    if (kind === "symlink") {
      rmSync(f.path);
      symlinkSync(join(f.root, "config"), f.path);
    }
    if (kind === "oversize") writeFileSync(f.path, "x".repeat(16_385));
    if (kind === "json") writeFileSync(f.path, "synthetic-secret");
    await expect(
      f.resolver.resolve(
        "otlp",
        kind === "cancelled" ? AbortSignal.abort() : new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      message: "Telemetry exporter operation failed.",
      code: "unavailable",
    });
  },
);

it("accepts the exact private byte bound and rejects a foreign owner", async () => {
  const f = fixture();
  const value = { endpoint: connection.endpoint, headers: { authorization: "" } };
  value.headers.authorization = "x".repeat(16_384 - Buffer.byteLength(JSON.stringify(value)));
  f.write(value);
  await expect(f.resolver.resolve("otlp", new AbortController().signal)).resolves.toEqual(value);
  await expect(
    privateTelemetryResolver(f.root, -1).resolve("otlp", new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});
it("rejects unknown fields, malformed UTF-8 and incomplete Langfuse secrets", async () => {
  const f = fixture();
  f.write({ ...connection, student: "synthetic-private" });
  await expect(f.resolver.resolve("otlp", new AbortController().signal)).rejects.toMatchObject({
    code: "unavailable",
  });
  writeFileSync(
    f.path,
    Buffer.concat([
      Buffer.from('{"endpoint":"https://collector.invalid","headers":{"auth":"'),
      Buffer.from([255]),
      Buffer.from('"}}'),
    ]),
  );
  await expect(f.resolver.resolve("otlp", new AbortController().signal)).rejects.toMatchObject({
    code: "unavailable",
  });
  writeFileSync(
    join(f.root, "config", "telemetry-langfuse.json"),
    JSON.stringify({ endpoint: connection.endpoint, publicKey: "synthetic-public", secretKey: "" }),
    { mode: 0o600 },
  );
  await expect(f.resolver.resolve("langfuse", new AbortController().signal)).rejects.toMatchObject({
    code: "unavailable",
  });
});
