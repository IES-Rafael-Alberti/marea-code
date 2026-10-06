import { networkInterfaces } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { readTeacherHostConfig } from "./teacher-host-config.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "./teacher-host.fixture.js";
import { httpConnectionUrls, localHttpHosts, withHttpAccess } from "./http-access.boundary.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  networkInterfaces: vi.fn(),
}));
afterEach(cleanupTeacherHostInstallations);

it("enumerates only concrete IPv4 hosts, deduplicating loopback and repeated interfaces", () => {
  const iface = (address: string, family: "IPv4" | "IPv6") => ({
    address,
    family,
    netmask: "",
    mac: "",
    internal: false,
    cidr: null,
    scopeid: 0,
  });
  vi.mocked(networkInterfaces).mockReturnValue({
    missing: undefined,
    loopback: [iface("127.0.0.1", "IPv4"), iface("::1", "IPv6")],
    en0: [iface("192.168.1.20", "IPv4"), iface("fe80::1", "IPv6")],
    duplicate: [iface("192.168.1.20", "IPv4")],
  });
  expect(localHttpHosts()).toEqual(["localhost", "127.0.0.1", "192.168.1.20"]);
});

it("overrides only HTTP access for this invocation, retaining exact existing admissions", () => {
  const f = teacherHostInstallation();
  f.writeHost({
    ...f.host,
    listen: { hostname: "127.0.0.1", port: 18787 },
    secureDashboardCookie: true,
  });
  const config = readTeacherHostConfig(f.root);
  const saved = structuredClone(config);
  expect(withHttpAccess(config, undefined)).toBe(config);
  const http = withHttpAccess(config, ["localhost", "192.168.1.20", "192.168.1.20"]);
  expect(http).toEqual({
    ...config,
    listen: { hostname: "0.0.0.0", port: 18787 },
    allowedHosts: ["teacher.test", "localhost:18787", "192.168.1.20:18787"],
    allowedOrigins: [
      "https://dashboard.test",
      "http://localhost:18787",
      "http://192.168.1.20:18787",
    ],
    secureDashboardCookie: false,
  });
  expect(config).toEqual(saved);
  expect(
    withHttpAccess({ ...config, listen: { ...config.listen, port: 80 } }, ["localhost"]),
  ).toMatchObject({
    allowedHosts: ["teacher.test", "localhost"],
    allowedOrigins: ["https://dashboard.test", "http://localhost"],
  });
  expect(() => withHttpAccess({ ...config, listen: { ...config.listen, port: 0 } }, [])).toThrow(
    "HTTP LAN access requires a fixed listening port",
  );
});

it("prints origins for the actual listening port, including default port normalization", () => {
  expect(httpConnectionUrls(["localhost", "192.168.1.20"], "http://0.0.0.0:18787")).toEqual([
    "http://localhost:18787",
    "http://192.168.1.20:18787",
  ]);
  expect(httpConnectionUrls(["127.0.0.1"], "http://0.0.0.0:80")).toEqual(["http://127.0.0.1"]);
});
