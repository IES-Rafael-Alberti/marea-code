import type { PasswordHasher } from "./contracts.js";

export const bunArgon2idPasswordHasher: PasswordHasher = Object.freeze({
  async hash(password: string): Promise<string> {
    return Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    });
  },
  async verify(password: string, passwordHash: string): Promise<boolean> {
    return Bun.password.verify(password, passwordHash, "argon2id");
  },
});
