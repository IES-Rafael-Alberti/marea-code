import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  chmodSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { serverSettingsStore } from "./server-settings-store.boundary.js";
import { ServerSettingsSchema } from "../../server-settings/contracts.js";
import type { ServerSettings } from "../../server-settings/contracts.js";
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-server-settings-")));
  roots.push(root);
  mkdirSync(join(root, "config"), { mode: 0o700 });
  const value: ServerSettings = {
    version: 1,
    revision: 0,
    administrators: ["user:owner"],
    connections: {},
    route: null,
    legacyRoutes: [],
    education: {},
    useCommonRoute: false,
  };
  return { root, value, store: serverSettingsStore(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("creates private settings once and atomically persists revision-checked changes", () => {
  const f = fixture();
  expect(f.store.read()).toBeNull();
  f.store.write(f.value, -1);
  const path = join(f.root, "config", "server-settings.json");
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const before = readFileSync(path, "utf8");
  expect(() => {
    f.store.write({ ...f.value, revision: 8 }, -1);
  }).toThrow();
  expect(readFileSync(path, "utf8")).toBe(before);
  f.store.write(
    {
      ...f.value,
      revision: 1,
      connections: { "synthetic.provider": { token: "synthetic-secret" } },
    },
    0,
  );
  expect(serverSettingsStore(f.root).read()).toMatchObject({
    revision: 1,
    connections: { "synthetic.provider": { token: "synthetic-secret" } },
  });
});
it("rejects a symlink destination without changing its target", () => {
  const first = fixture();
  const second = fixture();
  second.store.write(second.value, -1);
  const target = join(second.root, "config", "server-settings.json");
  const before = readFileSync(target, "utf8");
  symlinkSync(target, join(first.root, "config", "server-settings.json"));
  expect(() => first.store.read()).toThrow();
  expect(() => {
    first.store.write(first.value, -1);
  }).toThrow();
  expect(readFileSync(target, "utf8")).toBe(before);
});
it("refuses oversized settings and a configuration directory others can read", () => {
  const large = fixture();
  const connections = { "synthetic.provider": { token: "x".repeat(2048) } };
  for (let index = 0; index < 140; index++)
    Object.assign(connections, {
      [`synthetic.provider.${String(index)}`]: { token: "x".repeat(2048) },
    });
  expect(() => {
    large.store.write({ ...large.value, connections }, -1);
  }).toThrow();
  const shared = fixture();
  chmodSync(join(shared.root, "config"), 0o755);
  expect(() => {
    shared.store.write(shared.value, -1);
  }).toThrow();
  for (const root of [large.root, shared.root])
    expect(existsSync(join(root, "config", "server-settings.json"))).toBe(false);
});
it("refuses a settings file others can read and malformed UTF-8 with a closed status", () => {
  const exposed = fixture();
  exposed.store.write(exposed.value, -1);
  const path = join(exposed.root, "config", "server-settings.json");
  chmodSync(path, 0o644);
  expect(() => exposed.store.read()).toThrow(expect.objectContaining({ status: 503 }) as object);
  const malformed = fixture();
  const text = JSON.stringify({ ...malformed.value, administrators: ["user:owner-X"] });
  const bytes = Buffer.from(text, "utf8");
  bytes[bytes.indexOf("X")] = 0xff;
  writeFileSync(join(malformed.root, "config", "server-settings.json"), bytes, { mode: 0o600 });
  expect(() => malformed.store.read()).toThrow(TypeError);
});
it("accepts settings of exactly the size limit", () => {
  const f = fixture();
  const connections: Record<string, Record<string, string>> = {};
  const size = () =>
    Buffer.byteLength(JSON.stringify(ServerSettingsSchema.parse({ ...f.value, connections })));
  for (let index = 0; size() < 262144 - 2100; index++)
    connections[`p${String(index)}`] = { token: "x".repeat(2048) };
  connections.last = { token: "" };
  connections.last.token = "x".repeat(262144 - size());
  expect(size()).toBe(262144);
  f.store.write({ ...f.value, connections }, -1);
  expect(f.store.read()?.connections.last?.token).toHaveLength(connections.last.token.length);
});
