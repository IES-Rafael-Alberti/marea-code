import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorCliError } from "../operator-cli/errors.js";
import { captured } from "./captured.js";
import { readTeacherHostConfig } from "./teacher-host-config.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "./teacher-host.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupTeacherHostInstallations);

const UNAVAILABLE = new OperatorCliError("prerequisite-unavailable");

describe("teacher host configuration", () => {
  it("accepts a separate private program distribution while confining secrets and status to data", () => {
    const f = teacherHostInstallation({ activate: false });
    const programs = teacherHostInstallation({ activate: false });
    const dashboardDistPath = programs.host.dashboardDistPath;
    const configured = { ...f.host, dashboardDistPath };
    f.writeHost(configured);
    expect(readTeacherHostConfig(f.root)).toEqual(configured);
    for (const field of ["digestKeyPath", "statusPath"] as const) {
      f.writeHost({ ...configured, [field]: programs.host.digestKeyPath });
      expect(() => readTeacherHostConfig(f.root)).toThrow(UNAVAILABLE);
    }
    f.writeHost(configured);
    chmodSync(dashboardDistPath, 0o755);
    expect(() => readTeacherHostConfig(f.root)).toThrow(UNAVAILABLE);
    chmodSync(dashboardDistPath, 0o700);
    const alias = join(f.root, "program-alias");
    symlinkSync(programs.root, alias);
    f.writeHost({ ...configured, dashboardDistPath: join(alias, "dashboard") });
    expect(() => readTeacherHostConfig(f.root)).toThrow(UNAVAILABLE);
  });

  it("reads the strict document with configured providers and an absent or private status file", () => {
    const f = teacherHostInstallation({ activate: false });
    writeFileSync(join(f.root, "state", "openrouter.key"), "secret\n", { mode: 0o600 });
    const providers = [
      { pluginId: "org.marea.openrouter", credentialPath: join(f.root, "state", "openrouter.key") },
    ];
    writeFileSync(join(f.root, "state", "other.key"), "secret\n", { mode: 0o600 });
    const configured = {
      ...f.host,
      listen: { hostname: "127.0.0.1", port: 65_535 },
      allowedHosts: ["teacher.test", "127.0.0.1"],
      allowedOrigins: ["https://dashboard.test", "http://127.0.0.1"],
      providers: [
        ...providers,
        { pluginId: "org.example.other", credentialPath: join(f.root, "state", "other.key") },
      ],
    };
    f.writeHost(configured);
    expect(readTeacherHostConfig(f.root)).toEqual(configured);
    f.writeHost({ ...f.host, providers });
    expect(readTeacherHostConfig(f.root)).toEqual({ ...f.host, providers });
    writeFileSync(f.host.statusPath, "{}", { mode: 0o600 });
    expect(readTeacherHostConfig(f.root).statusPath).toBe(f.host.statusPath);
    const rootStatus = { ...f.host, statusPath: join(f.root, "status.json") };
    f.writeHost(rootStatus);
    expect(readTeacherHostConfig(f.root)).toEqual(rootStatus);
  });

  it("refuses missing, public, duplicate or unexpected host prerequisites", () => {
    const f = teacherHostInstallation({ activate: false });
    const refuse = (value: unknown) => {
      f.writeHost(value);
      expect(() => readTeacherHostConfig(f.root)).toThrow(UNAVAILABLE);
    };
    expect(() => readTeacherHostConfig(f.root, -1)).toThrow(UNAVAILABLE);
    const configPath = join(f.root, "config", "teacher-host.json");
    rmSync(configPath);
    mkdirSync(configPath, { mode: 0o700 });
    expect(() => readTeacherHostConfig(f.root)).toThrow(UNAVAILABLE);
    rmSync(configPath, { recursive: true });
    const encoded = new TextEncoder().encode(JSON.stringify({ ...f.host, allowedHosts: ["@"] }));
    encoded[encoded.indexOf(64)] = 0xff;
    writeFileSync(configPath, encoded, { mode: 0o600 });
    expect(() => readTeacherHostConfig(f.root)).toThrow("The encoded data was not valid");
    refuse({ ...f.host, digestKeyPath: join(f.root, "state") });
    // Missing files fail while resolving their canonical path; the host reports both as config.
    f.writeHost({ ...f.host, digestKeyPath: join(f.root, "state", "missing.key") });
    expect(() => readTeacherHostConfig(f.root)).toThrow();
    refuse({ ...f.host, dashboardDistPath: f.host.digestKeyPath });
    f.writeHost({ ...f.host, statusPath: join(f.root, "missing", "status.json") });
    expect(() => readTeacherHostConfig(f.root)).toThrow();
    mkdirSync(join(f.root, "public"), { mode: 0o755 });
    refuse({ ...f.host, statusPath: join(f.root, "public", "status.json") });
    const credential = join(f.root, "state", "provider.key");
    writeFileSync(credential, "secret", { mode: 0o600 });
    refuse({
      ...f.host,
      providers: [
        { pluginId: "org.marea.openrouter", credentialPath: credential },
        { pluginId: "org.marea.openrouter", credentialPath: credential },
      ],
    });
    refuse({
      ...f.host,
      providers: [{ pluginId: "org.marea.openrouter", credentialPath: join(f.root, "state") }],
    });
    f.writeHost({ ...f.host, unexpected: true });
    expect(() => readTeacherHostConfig(f.root)).toThrow();
  });

  it("reports host state read before it was captured", () => {
    expect(captured(1)).toBe(1);
    expect(() => {
      captured(undefined);
    }).toThrow("The teacher host state is not available yet.");
  });
});
