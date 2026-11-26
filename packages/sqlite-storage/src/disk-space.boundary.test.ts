import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diskSpace } from "./disk-space.boundary.js";

describe("disk space", () => {
  it("reports the bytes available to this process on the volume of a directory", () => {
    const free = diskSpace.freeBytes(tmpdir());
    expect(free).toBeGreaterThan(0);
    expect(Number.isSafeInteger(free)).toBe(true);
  });

  it("reports an unknown volume as unknown instead of failing", () => {
    expect(diskSpace.freeBytes(join(tmpdir(), "marea-missing-volume", "nested"))).toBeUndefined();
  });
});
