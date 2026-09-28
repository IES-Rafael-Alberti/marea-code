import { fstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readBoundedRegularFile } from "./artifact.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";

const environment = startRecoveryTest("marea-recovery-read-");
const root = environment.root;

describe("recovery bounded reads", () => {
  it("bounds regular reads and closes the descriptor", () => {
    const path = join(root(), "exact-read");
    const bytes = new Uint8Array(64);
    writeFileSync(path, bytes);
    expect(readBoundedRegularFile(path, 64, "bundle-database-invalid")).toEqual(bytes);

    const multiChunk = new Uint8Array(65_536 + 1);
    const multiPath = join(root(), "multi-chunk-read");
    writeFileSync(multiPath, multiChunk);
    expect(readBoundedRegularFile(multiPath, 131_072, "bundle-database-invalid")).toEqual(
      multiChunk,
    );

    let closed = 0;
    readBoundedRegularFile(path, 64, "bundle-database-invalid", {
      closeSync: () => {
        closed += 1;
      },
    });
    expect(closed).toBe(1);

    for (const maximumBytes of [Number.NaN, 1.5, 0, -1]) {
      expectRecoveryError(
        () => readBoundedRegularFile(path, maximumBytes, "bundle-database-invalid"),
        "bundle-database-invalid",
      );
    }

    const oversizedPath = join(root(), "oversized-before-read");
    writeFileSync(oversizedPath, new Uint8Array(65));
    expectRecoveryError(
      () => readBoundedRegularFile(oversizedPath, 64, "bundle-database-invalid"),
      "bundle-database-invalid",
    );

    const emptyPath = join(root(), "empty-bounded-read");
    writeFileSync(emptyPath, "");
    expect(readBoundedRegularFile(emptyPath, 0, "bundle-database-invalid")).toEqual(
      new Uint8Array(0),
    );
  });

  it("rejects short and oversized reads", () => {
    const path = join(root(), "short-read");
    const bytes = new TextEncoder().encode("abcde");
    writeFileSync(path, bytes);
    let reads = 0;
    expectRecoveryError(
      () =>
        readBoundedRegularFile(path, 64, "bundle-database-invalid", {
          closeSync: () => undefined,
          fstatSync: () => ({
            isFile: () => true,
            nlink: 1,
            dev: 1,
            ino: 1,
            size: 5,
            mtimeMs: 1,
            ctimeMs: 1,
          }),
          readSync: (_descriptor: number, buffer: Uint8Array) => {
            reads += 1;
            if (reads > 1) return 0;
            buffer.fill(97, 0, 4);
            return 4;
          },
        }),
      "bundle-database-invalid",
    );

    const oversizedPath = join(root(), "oversized-read");
    const oversizedBytes = new TextEncoder().encode("a");
    writeFileSync(oversizedPath, oversizedBytes);
    expectRecoveryError(
      () =>
        readBoundedRegularFile(oversizedPath, 64, "bundle-database-invalid", {
          closeSync: () => undefined,
          fstatSync: () => ({
            isFile: () => true,
            nlink: 1,
            dev: 1,
            ino: 1,
            size: 1,
            mtimeMs: 1,
            ctimeMs: 1,
          }),
          readSync: () => 65_536,
        }),
      "bundle-database-invalid",
    );

    const nonRegularPath = join(root(), "non-regular");
    writeFileSync(nonRegularPath, "bytes");
    expectRecoveryError(
      () =>
        readBoundedRegularFile(nonRegularPath, 64, "bundle-database-invalid", {
          closeSync: () => undefined,
          fstatSync: () => ({
            isFile: () => false,
            nlink: 1,
            dev: 1,
            ino: 1,
            size: 5,
            mtimeMs: 1,
            ctimeMs: 1,
          }),
          readSync: () => 5,
        }),
      "bundle-database-invalid",
    );
  });

  it("rejects changed identity metadata with injected descriptors", () => {
    const path = join(root(), "injected-metadata");
    writeFileSync(path, "bytes");
    for (const change of [
      { dev: 999_999 },
      { ino: 999_999 },
      { size: 99 },
      { mtimeMs: 999_999 },
      { ctimeMs: 999_999 },
    ] as const) {
      let call = 0;
      let readCall = 0;
      expectRecoveryError(
        () =>
          readBoundedRegularFile(path, 64, "bundle-database-invalid", {
            closeSync: () => undefined,
            fstatSync: (descriptor: number) => {
              const before = fstatSync(descriptor);
              return call++ === 0 ? before : Object.assign({}, before, change);
            },
            readSync: (_descriptor: number, buffer: Uint8Array) => {
              readCall += 1;
              if (readCall > 1) return 0;
              buffer.fill(97, 0, 5);
              return 5;
            },
          }),
        "bundle-database-invalid",
      );
      expect(call).toBe(2);
    }
  });
});
