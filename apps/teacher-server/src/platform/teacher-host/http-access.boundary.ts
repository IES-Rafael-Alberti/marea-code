import { networkInterfaces } from "node:os";
import type { TeacherHostConfig } from "./teacher-host-config.js";

/** Enumerate concrete IPv4 interfaces; never use wildcard Host or Origin admission. */
export function localHttpHosts(): string[] {
  const interfaces = Object.values(networkInterfaces()).flat();
  return [
    ...new Set([
      "localhost",
      "127.0.0.1",
      ...interfaces.filter((entry) => entry?.family === "IPv4").map((entry) => entry.address),
    ]),
  ];
}

/** An invocation-only override. The private on-disk configuration stays unchanged. */
export function withHttpAccess(
  config: TeacherHostConfig,
  hosts: readonly string[] | undefined,
): TeacherHostConfig {
  if (hosts === undefined) return config;
  if (config.listen.port === 0) throw new Error("HTTP LAN access requires a fixed listening port");
  const origins = hosts.map((host) => new URL(`http://${host}:${String(config.listen.port)}`));
  return {
    ...config,
    listen: { ...config.listen, hostname: "0.0.0.0" },
    allowedHosts: [...new Set([...config.allowedHosts, ...origins.map((origin) => origin.host)])],
    allowedOrigins: [
      ...new Set([...config.allowedOrigins, ...origins.map((origin) => origin.origin)]),
    ],
    secureDashboardCookie: false,
  };
}

export function httpConnectionUrls(hosts: readonly string[], listeningUrl: string): string[] {
  const port = new URL(listeningUrl).port;
  return hosts.map((host) => new URL(`http://${host}:${port}`).origin);
}
