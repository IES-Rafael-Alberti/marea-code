import { afterEach, describe, expect, it, vi } from "vitest";

import { bunArgon2idPasswordHasher } from "./password-hasher.boundary.js";
import {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
  systemClock,
} from "./system-security.boundary.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("identity security boundaries", () => {
  it("binds password hashing and verification to Argon2id", async () => {
    const hash = vi.fn(() => Promise.resolve("argon-hash"));
    const verify = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("Bun", { password: { hash, verify } });

    await expect(bunArgon2idPasswordHasher.hash("student-password")).resolves.toBe("argon-hash");
    await expect(bunArgon2idPasswordHasher.verify("student-password", "argon-hash")).resolves.toBe(
      true,
    );
    expect(hash).toHaveBeenCalledWith("student-password", {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    });
    expect(verify).toHaveBeenCalledWith("student-password", "argon-hash", "argon2id");
  });

  it("creates opaque identifiers, secrets, UTC timestamps, and peppered stable digests", () => {
    const id = cryptoIdGenerator.createId("run");
    const secret = cryptoSecretIssuer.issue();
    const timestamp = systemClock.now();
    const pepper = Uint8Array.from({ length: 32 }, (_, index) => index);
    const digest = createHmacSecretDigest(pepper);

    expect(id).toMatch(/^run:[\da-f-]{36}$/u);
    expect(secret).toMatch(/^[A-Za-z\d_-]{43}$/u);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(digest.digest("token")).toMatch(/^[a-f\d]{64}$/u);
    expect(digest.digest("token")).toBe(digest.digest("token"));
    pepper.fill(0);
    expect(digest.digest("token")).not.toBe(
      createHmacSecretDigest(new Uint8Array(32)).digest("token"),
    );
    expect(() => createHmacSecretDigest(new Uint8Array(31))).toThrow(
      "The credential digest pepper must contain at least 32 bytes.",
    );
  });
});
