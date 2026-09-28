import { TeacherDomainError } from "./errors.js";

/** Two Argon2 jobs use at most 128 MiB of configured hash memory per service. */
const MAX_CONCURRENT_PASSWORD_OPERATIONS = 2;

/** Shared by enrollment and both login routes; rejected work is never queued. */
export class PasswordAdmission {
  private active = 0;

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_PASSWORD_OPERATIONS)
      throw new TeacherDomainError("auth.busy");
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}
